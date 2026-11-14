"""The Qt side of the ULTRON native player (see native_player.py for the why).

  Stage      QOpenGLWidget that mpv renders into (render API). The controls are ordinary child widgets painted OVER it.
  SeekBar    custom timeline with buffered range and a hover preview (frames come from the server's /strip endpoint)
  Player     the window: wiring of mpv <-> controls <-> ULTRON server (progress, views, subtitles, episodes)
"""
from __future__ import annotations

import ctypes
import json
import math
import os
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
from pathlib import Path

os.environ.setdefault("QT_OPENGL", "desktop")                 # real OpenGL, not ANGLE: mpv wants desktop GL

from PySide6.QtCore import QEvent, QObject, QPoint, QPointF, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import (QColor, QCursor, QFont, QIcon, QImage, QLinearGradient, QOpenGLContext, QPainter, QPainterPath,
                           QPen, QPixmap, QPolygonF, QSurfaceFormat)
from PySide6.QtOpenGLWidgets import QOpenGLWidget
from PySide6.QtWidgets import (QAbstractButton, QApplication, QCheckBox, QFileDialog, QHBoxLayout, QLabel, QMainWindow, QMenu,
                               QPushButton, QVBoxLayout, QWidget)

import mpv_backend
from native_player import APP_DIR, EXIT_FAIL, EXIT_OK, FROZEN, fmt_time, log

ACCENT = QColor("#e11d2e")
PANEL = QColor(14, 14, 18, 222)
LINE = QColor(255, 255, 255, 34)
TXT = QColor("#f2f2f4")
DIM = QColor(255, 255, 255, 150)

LANGS = {"eng": "English", "en": "English", "jpn": "Japanese", "ja": "Japanese", "fre": "French", "fra": "French", "fr": "French",
         "spa": "Spanish", "es": "Spanish", "ger": "German", "deu": "German", "de": "German", "ita": "Italian", "it": "Italian",
         "por": "Portuguese", "pt": "Portuguese", "rus": "Russian", "ru": "Russian", "kor": "Korean", "ko": "Korean",
         "chi": "Chinese", "zho": "Chinese", "zh": "Chinese", "ara": "Arabic", "ar": "Arabic", "hin": "Hindi", "hi": "Hindi",
         "tha": "Thai", "vie": "Vietnamese", "ind": "Indonesian", "tur": "Turkish", "pol": "Polish", "dut": "Dutch", "nld": "Dutch",
         "swe": "Swedish", "tgl": "Filipino", "fil": "Filipino", "und": "Unknown"}


def lang_name(code):
    c = str(code or "").lower()
    return LANGS.get(c) or LANGS.get(c[:2]) or (c.upper() if c else "")


# ============================================================================= icons
def paint_icon(p, name, r, color):
    """Small line/solid icons drawn in a 24x24 box, so there is no icon font to ship or to go missing."""
    p.save()
    p.setRenderHint(QPainter.Antialiasing, True)
    p.translate(r.x(), r.y())
    s = min(r.width(), r.height()) / 24.0
    p.scale(s, s)
    pen = QPen(color, 2.0, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin)
    p.setPen(Qt.NoPen)
    p.setBrush(color)
    poly = lambda pts: p.drawPolygon(QPolygonF([QPointF(x, y) for x, y in pts]))
    if name == "play":
        poly([(7, 4.5), (19.5, 12), (7, 19.5)])
    elif name == "pause":
        p.drawRoundedRect(QRectF(6.5, 5, 4, 14), 1, 1)
        p.drawRoundedRect(QRectF(13.5, 5, 4, 14), 1, 1)
    elif name in ("prev", "next"):
        if name == "prev":
            p.drawRoundedRect(QRectF(5.5, 5, 2.6, 14), 1, 1)
            poly([(19, 5), (9.5, 12), (19, 19)])
        else:
            p.drawRoundedRect(QRectF(15.9, 5, 2.6, 14), 1, 1)
            poly([(5, 5), (14.5, 12), (5, 19)])
    elif name in ("back10", "fwd10"):
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        fwd = name == "fwd10"
        p.drawArc(QRectF(4.5, 5, 15, 15), (60 if fwd else 120) * 16, (-300 if fwd else 300) * 16)
        p.setPen(Qt.NoPen)
        p.setBrush(color)
        if fwd:
            poly([(14.5, 1.8), (19.5, 5.4), (14.5, 9)])
        else:
            poly([(9.5, 1.8), (4.5, 5.4), (9.5, 9)])
        f = QFont("Segoe UI", 1)
        f.setPixelSize(8)
        f.setBold(True)
        p.setFont(f)
        p.setPen(color)
        p.drawText(QRectF(4.5, 8.2, 15, 11), Qt.AlignCenter, "10")
    elif name in ("vol", "mute"):
        poly([(4, 9.5), (8, 9.5), (13, 5), (13, 19), (8, 14.5), (4, 14.5)])
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        if name == "vol":
            p.drawArc(QRectF(10, 7.5, 7, 9), -60 * 16, 120 * 16)
            p.drawArc(QRectF(8.5, 4.5, 12, 15), -60 * 16, 120 * 16)
        else:
            p.drawLine(QPointF(16, 9.5), QPointF(21, 14.5))
            p.drawLine(QPointF(21, 9.5), QPointF(16, 14.5))
    elif name in ("fs", "unfs"):
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        a, b, d = 4.5, 19.5, 5.5
        if name == "fs":
            for (x, y, dx, dy) in ((a, a, 1, 1), (b, a, -1, 1), (a, b, 1, -1), (b, b, -1, -1)):
                p.drawLine(QPointF(x, y), QPointF(x + dx * d, y))
                p.drawLine(QPointF(x, y), QPointF(x, y + dy * d))
        else:
            for (x, y, dx, dy) in ((a + d, a + d, -1, -1), (b - d, a + d, 1, -1), (a + d, b - d, -1, 1), (b - d, b - d, 1, 1)):
                p.drawLine(QPointF(x, y), QPointF(x + dx * d, y))
                p.drawLine(QPointF(x, y), QPointF(x, y + dy * d))
    elif name == "cc":
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        p.drawRoundedRect(QRectF(3, 5.5, 18, 13), 3, 3)
        p.setPen(Qt.NoPen)
        p.setBrush(color)
        f = QFont("Segoe UI", 1)
        f.setPixelSize(8)
        f.setBold(True)
        p.setFont(f)
        p.setPen(color)
        p.drawText(QRectF(3, 5.5, 18, 13), Qt.AlignCenter, "CC")
    elif name == "audio":
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        p.drawArc(QRectF(4.5, 4.5, 15, 15), 0, 180 * 16)
        p.setPen(Qt.NoPen)
        p.setBrush(color)
        p.drawRoundedRect(QRectF(3.5, 12, 4, 7), 1.6, 1.6)
        p.drawRoundedRect(QRectF(16.5, 12, 4, 7), 1.6, 1.6)
    elif name == "cam":
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        p.drawRoundedRect(QRectF(3, 7, 18, 12), 3, 3)
        p.drawEllipse(QRectF(8.5, 9.5, 7, 7))
        p.drawLine(QPointF(8, 7), QPointF(9.5, 4.5))
        p.drawLine(QPointF(9.5, 4.5), QPointF(14.5, 4.5))
        p.drawLine(QPointF(14.5, 4.5), QPointF(16, 7))
    elif name == "mini":
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        p.drawRoundedRect(QRectF(3, 5, 18, 14), 3, 3)
        p.setBrush(color)
        p.setPen(Qt.NoPen)
        p.drawRoundedRect(QRectF(11.5, 11, 7, 5.5), 1.5, 1.5)
    elif name == "bulb":
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        path = QPainterPath()
        path.moveTo(9, 15.5)
        path.cubicTo(5.5, 13, 5.5, 5.5, 12, 4.5)
        path.cubicTo(18.5, 5.5, 18.5, 13, 15, 15.5)
        path.lineTo(15, 17.5)
        path.lineTo(9, 17.5)
        path.closeSubpath()
        p.drawPath(path)
        p.drawLine(QPointF(9.5, 20.2), QPointF(14.5, 20.2))
    elif name == "pencil":
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        p.drawPolygon(QPolygonF([QPointF(4, 20), QPointF(5, 15), QPointF(15.5, 4.5), QPointF(19.5, 8.5), QPointF(9, 19)]))
        p.drawLine(QPointF(13, 7), QPointF(17, 11))
    elif name == "moon":
        path = QPainterPath()
        path.moveTo(15.5, 3.5)
        path.cubicTo(8.0, 4.0, 4.5, 10.0, 6.5, 15.5)
        path.cubicTo(8.5, 20.5, 14.5, 22.0, 19.5, 18.0)
        path.cubicTo(13.5, 17.5, 10.0, 11.5, 15.5, 3.5)
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        p.drawPath(path)
    elif name == "fit":
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):          # four corner brackets = picture frame
            cx, cy = 12 - sx * 8, 12 - sy * 6
            p.drawLine(QPointF(cx, cy), QPointF(cx + sx * 4, cy))
            p.drawLine(QPointF(cx, cy), QPointF(cx, cy + sy * 4))
        p.drawRect(QRectF(9, 9.5, 6, 5))
    elif name == "scissors":
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        p.drawEllipse(QPointF(6, 18), 3, 3)
        p.drawEllipse(QPointF(6, 6), 3, 3)
        p.drawLine(QPointF(8.4, 7.8), QPointF(20, 18.5))
        p.drawLine(QPointF(8.4, 16.2), QPointF(20, 5.5))
    elif name == "back":
        p.setBrush(Qt.NoBrush)
        p.setPen(pen)
        p.drawLine(QPointF(19, 12), QPointF(5, 12))
        p.drawLine(QPointF(5, 12), QPointF(11, 6))
        p.drawLine(QPointF(5, 12), QPointF(11, 18))
    p.restore()


class IconButton(QAbstractButton):
    def __init__(self, icon, tip="", size=40, text="", parent=None):
        super().__init__(parent)
        self.icon_name, self.label, self.accent = icon, text, False
        self.setFixedSize(size if not text else max(size, 46), size)
        self.setToolTip(tip)
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.NoFocus)
        self.setMouseTracking(True)
        self._hover = False

    def set_icon(self, name):
        if name != self.icon_name:
            self.icon_name = name
            self.update()

    def enterEvent(self, e):
        self._hover = True
        self.update()

    def leaveEvent(self, e):
        self._hover = False
        self.update()

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        if self._hover:
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(255, 255, 255, 30))
            p.drawRoundedRect(self.rect().adjusted(2, 2, -2, -2), 10, 10)
        col = ACCENT.lighter(135) if self.accent else TXT
        if self.label:
            f = QFont("Segoe UI", 10)
            f.setBold(True)
            p.setFont(f)
            p.setPen(col)
            p.drawText(self.rect(), Qt.AlignCenter, self.label)
        else:
            s = min(self.width(), self.height()) - 16
            paint_icon(p, self.icon_name, QRectF((self.width() - s) / 2, (self.height() - s) / 2, s, s), col)


class Pill(QPushButton):
    def __init__(self, text, icon=None, parent=None):
        super().__init__(text, parent)
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.NoFocus)
        self.setStyleSheet("QPushButton{background:rgba(20,20,24,205);border:1px solid rgba(255,255,255,40);border-radius:19px;"
                           "color:#fff;padding:0 18px;font:700 10pt 'Segoe UI';letter-spacing:1px;min-height:38px;}"
                           "QPushButton:hover{border-color:#e11d2e;background:rgba(40,12,16,225);}")


# ============================================================================= seek bar + volume
class SeekBar(QWidget):
    seeked = Signal(float, bool)        # (fraction, final)
    hovered = Signal(float, int)        # (fraction, x inside the bar) ; -1 when the mouse leaves

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(24)
        self.setMouseTracking(True)
        self.setCursor(Qt.PointingHandCursor)
        self.pos_f = self.buf_f = 0.0
        self.hover_f = -1.0
        self.dragging = False
        self.marks = []
        self.loop = (None, None)            # A-B loop as fractions of the duration
        self.chapters = []                  # chapter starts as fractions of the duration
        self.wave, self.playing, self.phase = True, False, 0.0      # Ultron look: the played part is a moving red wave
        self._wt = QTimer(self)
        self._wt.setInterval(40)
        self._wt.timeout.connect(self._wave_step)
        self._wt.start()

    def _wave_step(self):
        if self.wave and self.playing and self.isVisible():
            self.phase += 0.45
            self.update()

    def set_state(self, pos_f, buf_f):
        self.pos_f, self.buf_f = max(0.0, min(1.0, pos_f)), max(0.0, min(1.0, buf_f))
        self.update()

    def _frac(self, x):
        return max(0.0, min(1.0, (x - 6) / max(1.0, self.width() - 12)))

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            self.dragging = True
            self.pos_f = self._frac(e.position().x())
            self.seeked.emit(self.pos_f, False)
            self.update()

    def mouseMoveEvent(self, e):
        f = self._frac(e.position().x())
        self.hover_f = f
        self.hovered.emit(f, int(e.position().x()))
        if self.dragging:
            self.pos_f = f
            self.seeked.emit(f, False)
        self.update()

    def mouseReleaseEvent(self, e):
        if self.dragging and e.button() == Qt.LeftButton:
            self.dragging = False
            self.seeked.emit(self._frac(e.position().x()), True)
            self.update()

    def leaveEvent(self, e):
        self.hover_f = -1.0
        self.hovered.emit(-1.0, -1)
        self.update()

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        w, cy = self.width() - 12, self.height() / 2
        big = self.hover_f >= 0 or self.dragging
        th = 6 if big else 4
        track = QRectF(6, cy - th / 2, w, th)
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(255, 255, 255, 50))
        p.drawRoundedRect(track, th / 2, th / 2)
        p.setBrush(QColor(255, 255, 255, 95))
        p.drawRoundedRect(QRectF(6, cy - th / 2, w * self.buf_f, th), th / 2, th / 2)
        if self.hover_f >= 0:
            p.setBrush(QColor(255, 255, 255, 60))
            p.drawRoundedRect(QRectF(6, cy - th / 2, w * self.hover_f, th), th / 2, th / 2)
        for cf in self.chapters:
            if 0.002 < cf < 0.998:
                p.setBrush(QColor(255, 255, 255, 150))
                p.drawRect(QRectF(6 + w * cf - 1, cy - th / 2 - 3, 2, th + 6))
        la, lb = self.loop
        if la is not None:
            xa = 6 + w * la
            xb = 6 + w * (lb if lb is not None else la)
            if lb is not None:
                p.setBrush(QColor(225, 29, 46, 85))
                p.drawRoundedRect(QRectF(xa, cy - 5, max(2.0, xb - xa), 10), 3, 3)
            p.setBrush(QColor("#ffffff"))
            p.drawRoundedRect(QRectF(xa - 1.5, cy - 8, 3, 16), 1.5, 1.5)
            if lb is not None:
                p.drawRoundedRect(QRectF(xb - 1.5, cy - 8, 3, 16), 1.5, 1.5)
        x1 = 6 + w * self.pos_f
        if self.wave and self.playing and not self.dragging and x1 > 14:
            path = QPainterPath()
            amp = 3.4 if big else 2.6
            path.moveTo(6, cy)
            x = 8.0
            while x < x1:
                env = 1.0 - min(1.0, (x1 - x) / 240.0) * 0.65          # strongest at the playhead, calmer behind it
                path.lineTo(x, cy + amp * env * math.sin(x * 0.2 - self.phase))
                x += 2.0
            p.setBrush(Qt.NoBrush)
            p.setPen(QPen(QColor(225, 29, 46, 70), th + 5, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin))
            p.drawPath(path)
            p.setPen(QPen(ACCENT, 2.6, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin))
            p.drawPath(path)
            p.setPen(Qt.NoPen)
        else:
            p.setBrush(ACCENT)
            p.drawRoundedRect(QRectF(6, cy - th / 2, w * self.pos_f, th), th / 2, th / 2)
        if big:
            p.setBrush(QColor("#ffffff"))
            p.drawEllipse(QPointF(x1, cy), 7, 7)


class VolumeBar(QWidget):
    changed = Signal(float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedSize(86, 24)
        self.setCursor(Qt.PointingHandCursor)
        self.v = 0.8
        self.muted = False

    def set_value(self, v, muted):
        self.v, self.muted = max(0.0, min(1.0, v)), muted
        self.update()

    def _set(self, x):
        self.changed.emit(max(0.0, min(1.0, (x - 6) / max(1.0, self.width() - 12))))

    def mousePressEvent(self, e):
        self._set(e.position().x())

    def mouseMoveEvent(self, e):
        if e.buttons() & Qt.LeftButton:
            self._set(e.position().x())

    def wheelEvent(self, e):
        self.changed.emit(max(0.0, min(1.0, self.v + (0.04 if e.angleDelta().y() > 0 else -0.04))))

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        w, cy = self.width() - 12, self.height() / 2
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(255, 255, 255, 50))
        p.drawRoundedRect(QRectF(6, cy - 2, w, 4), 2, 2)
        val = 0.0 if self.muted else self.v
        p.setBrush(QColor(255, 255, 255, 220))
        p.drawRoundedRect(QRectF(6, cy - 2, w * val, 4), 2, 2)
        p.drawEllipse(QPointF(6 + w * val, cy), 5.5, 5.5)


class Panel(QWidget):
    """A translucent rounded panel (bottom control bar)."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_NoMousePropagation, True)
        self.dim = False                                # theater mode: see-through bar
        self.ultron = True                              # Ultron look: cut corners + red hairline (U switches it off)

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        p.setPen(QPen(LINE, 1))
        p.setBrush(QColor(14, 14, 18, 120) if self.dim else PANEL)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        if not self.ultron:
            p.drawRoundedRect(r, 22, 22)
            return
        c = 18.0                                         # top-left and bottom-right corners are cut, the other two stay sharp-ish
        path = QPainterPath()
        path.moveTo(r.left() + c, r.top())
        path.lineTo(r.right() - 4, r.top())
        path.quadTo(r.right(), r.top(), r.right(), r.top() + 4)
        path.lineTo(r.right(), r.bottom() - c)
        path.lineTo(r.right() - c, r.bottom())
        path.lineTo(r.left() + 4, r.bottom())
        path.quadTo(r.left(), r.bottom(), r.left(), r.bottom() - 4)
        path.lineTo(r.left(), r.top() + c)
        path.closeSubpath()
        p.drawPath(path)
        p.setPen(QPen(ACCENT, 2, Qt.SolidLine, Qt.FlatCap))
        p.drawLine(QPointF(r.left() + c + 2, r.top() + 0.5), QPointF(r.left() + c + 70, r.top() + 0.5))
        p.drawLine(QPointF(r.right() - c - 2, r.bottom() - 0.5), QPointF(r.right() - c - 40, r.bottom() - 0.5))


class TopFade(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_NoMousePropagation, True)

    def paintEvent(self, e):
        p = QPainter(self)
        g = QLinearGradient(0, 0, 0, self.height())
        g.setColorAt(0, QColor(0, 0, 0, 185))
        g.setColorAt(1, QColor(0, 0, 0, 0))
        p.fillRect(self.rect(), g)


class Preview(QWidget):
    """Hover box above the timeline: a frame and the time."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        self.pix, self.text, self.chap = None, "", ""
        self.setFixedSize(188, 130)
        self.hide()

    def set_content(self, pix, text, chap=""):
        self.pix, self.text, self.chap = pix, text, chap
        h = 24 + (18 if chap else 0) + (int(176 * pix.height() / max(1, pix.width())) + 12 if pix is not None and not pix.isNull() else 0)
        self.setFixedSize(188, h)
        self.update()

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        p.setPen(QPen(LINE, 1))
        p.setBrush(QColor(12, 12, 16, 235))
        p.drawRoundedRect(QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5), 10, 10)
        y = 6
        if self.pix is not None and not self.pix.isNull():
            sc = self.pix.scaledToWidth(176, Qt.SmoothTransformation)
            path = QPainterPath()
            path.addRoundedRect(QRectF(6, 6, sc.width(), sc.height()), 6, 6)
            p.setClipPath(path)
            p.drawPixmap(6, 6, sc)
            p.setClipping(False)
            y = 6 + sc.height()
        f = QFont("Consolas", 10)
        f.setBold(True)
        p.setFont(f)
        p.setPen(TXT)
        if self.chap:
            p.drawText(QRectF(0, y, self.width(), 24), Qt.AlignCenter, self.text)
            f2 = QFont("Segoe UI", 9)
            p.setFont(f2)
            p.setPen(QColor(255, 255, 255, 190))
            p.drawText(QRectF(6, y + 20, self.width() - 12, 20), Qt.AlignCenter,
                       p.fontMetrics().elidedText(self.chap, Qt.ElideRight, self.width() - 12))
        else:
            p.drawText(QRectF(0, y, self.width(), self.height() - y), Qt.AlignCenter, self.text)


class Toast(QLabel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        self.setStyleSheet("background:rgba(14,14,18,225);color:#fff;border:1px solid rgba(255,255,255,40);border-radius:14px;"
                           "padding:8px 18px;font:600 11pt 'Segoe UI';")
        self.hide()
        self.t = QTimer(self)
        self.t.setSingleShot(True)
        self.t.timeout.connect(self.hide)

    def say(self, text, ms=1900):
        self.setText(text)
        self.adjustSize()
        self.move((self.parent().width() - self.width()) // 2, int(self.parent().height() * 0.12))
        self.show()
        self.raise_()
        self.t.start(ms)


class StarBar(QWidget):
    """Your rating for this video: five stars, click one to rate, click the same one again to clear."""
    rated = Signal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.value, self.hover = 0, 0
        self.setFixedSize(132, 28)
        self.setMouseTracking(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setToolTip("Your rating")

    def set_value(self, v):
        self.value = max(0, min(5, int(v or 0)))
        self.update()

    def _at(self, x):
        return max(1, min(5, int(x // 26) + 1))

    def mouseMoveEvent(self, e):
        self.hover = self._at(e.position().x())
        self.update()

    def leaveEvent(self, e):
        self.hover = 0
        self.update()

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            n = self._at(e.position().x())
            self.rated.emit(0 if n == self.value else n)

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        n = self.hover or self.value
        import math
        for i in range(5):
            cx, cy = 13 + i * 26, 14
            pts = []
            for k in range(10):
                r = 11 if k % 2 == 0 else 4.6
                a = -math.pi / 2 + k * math.pi / 5
                pts.append(QPointF(cx + r * math.cos(a), cy + r * math.sin(a)))
            on = i < n
            p.setPen(QPen(QColor(255, 255, 255, 120), 1.4) if not on else Qt.NoPen)
            p.setBrush(QColor("#f5b301") if on else Qt.NoBrush)
            p.drawPolygon(QPolygonF(pts))


class TitleCard(QWidget):
    """The big title that fades in over the picture when a video starts, then fades away."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        self.title, self.sub, self.age, self.alpha = "", "", 0.0, 0.0
        self.t = QTimer(self)
        self.t.setInterval(33)
        self.t.timeout.connect(self._step)
        self.hide()

    def show_card(self, title, sub=""):
        self.title, self.sub, self.age = title, sub, 0.0
        self.show()
        self.t.start()

    def stop(self):
        self.t.stop()
        self.hide()

    def _step(self):
        self.age += 0.033
        a = self.age
        self.alpha = min(1.0, a / 0.6) if a < 0.6 else (1.0 if a < 3.4 else max(0.0, 1.0 - (a - 3.4) / 1.0))
        if a >= 4.4:
            self.stop()
            return
        self.update()

    def paintEvent(self, e):
        if self.alpha <= 0:
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        p.setOpacity(self.alpha)
        x, w = 72, max(200, self.width() - 144)
        y = int(self.height() * 0.30) + int((1.0 - self.alpha) * 14)
        if self.sub:
            f = QFont("Segoe UI", 11)
            f.setBold(True)
            f.setLetterSpacing(QFont.AbsoluteSpacing, 4)
            p.setFont(f)
            p.setPen(ACCENT.lighter(125))
            p.drawText(QRectF(x, y - 34, w, 28), Qt.AlignLeft | Qt.AlignVCenter, self.sub.upper())
        f = QFont("Segoe UI", 34)
        f.setBold(True)
        p.setFont(f)
        r = QRectF(x, y, w, 220)
        p.setPen(QColor(0, 0, 0, 170))
        p.drawText(r.translated(2, 3), Qt.AlignLeft | Qt.AlignTop | Qt.TextWordWrap, self.title)
        p.setPen(QColor("#ffffff"))
        p.drawText(r, Qt.AlignLeft | Qt.AlignTop | Qt.TextWordWrap, self.title)


class HintsCard(QWidget):
    """Keyboard cheat sheet (press ? or F1). Any key or click closes it."""
    ROWS = (("Space / K", "Play or pause"), ("\u2190 \u2192", "Back / forward 5 s"), ("J  L", "Back / forward 10 s"),
            ("\u2191 \u2193", "Volume"), ("M", "Mute"), ("F  or  double click", "Fullscreen"), ("N  P", "Next / previous episode"),
            ("A", "Fit or fill"), ("+  \u2212  0", "Zoom in, out, reset"), ("Ctrl + wheel", "Zoom; drag to pan"),
            ("B", "A-B loop: start, end, clear"), ("T", "Precision trimmer (filmstrip, save clip)"), ("U", "Ultron look on / off"), ("I  O  \\", "Trimmer: set IN, set OUT, clear"), ("C", "Cycle subtitles"), ("Z  X", "Subtitles earlier / later"),
            ("G  H", "Subtitle size"), ("PgUp  PgDn", "Previous / next chapter"), ("[  ]", "Slower / faster"),
            (",  .", "Frame step (paused)"), ("S", "Screenshot"), ("D", "Lights: theater, night"), ("E", "Mini player (wheel seeks)"), ("Media keys", "Play, next, previous, stop"), ("F2", "Rename title"),
            ("?", "This list"), ("Esc", "Leave fullscreen / close"))

    def __init__(self, parent=None):
        super().__init__(parent)
        self.hide()

    def mousePressEvent(self, e):
        self.hide()

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        p.fillRect(self.rect(), QColor(0, 0, 0, 170))
        cw, rh = 330, 30
        half = (len(self.ROWS) + 1) // 2
        bw, bh = cw * 2 + 70, half * rh + 86
        x0, y0 = (self.width() - bw) // 2, max(10, (self.height() - bh) // 2)
        p.setPen(QPen(LINE, 1))
        p.setBrush(QColor(14, 14, 18, 240))
        p.drawRoundedRect(QRectF(x0, y0, bw, bh), 20, 20)
        f = QFont("Segoe UI", 10)
        f.setBold(True)
        f.setLetterSpacing(QFont.AbsoluteSpacing, 3)
        p.setFont(f)
        p.setPen(ACCENT.lighter(125))
        p.drawText(QRectF(x0 + 30, y0 + 18, 400, 24), Qt.AlignLeft | Qt.AlignVCenter, "KEYBOARD SHORTCUTS")
        for i, (k, d) in enumerate(self.ROWS):
            col, row = divmod(i, half)
            x, y = x0 + 30 + col * (cw + 10), y0 + 58 + row * rh
            kf = QFont("Consolas", 10)
            kf.setBold(True)
            p.setFont(kf)
            p.setPen(QColor("#ffffff"))
            p.drawText(QRectF(x, y, 120, rh), Qt.AlignLeft | Qt.AlignVCenter, k)
            p.setFont(QFont("Segoe UI", 10))
            p.setPen(QColor(255, 255, 255, 170))
            p.drawText(QRectF(x + 130, y, cw - 140, rh), Qt.AlignLeft | Qt.AlignVCenter, d)


class UpNextCard(QWidget):
    """The "Up next" card: next title, a countdown ring, Play now and Cancel. Shown when a video ends and another one follows."""
    play = Signal()
    cancel = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_NoMousePropagation, True)
        self.total, self.left, self.title, self.sub = 8.0, 8.0, "", ""
        self.t = QTimer(self)
        self.t.setInterval(50)
        self.t.timeout.connect(self._step)
        self.setFixedSize(380, 150)
        self.lbl_k = QLabel("UP NEXT", self)
        self.lbl_k.setStyleSheet("color:#e11d2e;font:800 9pt 'Segoe UI';letter-spacing:3px;background:transparent;")
        self.lbl_k.setGeometry(22, 14, 200, 18)
        self.lbl_t = QLabel("", self)
        self.lbl_t.setStyleSheet("color:#fff;font:600 12pt 'Segoe UI';background:transparent;")
        self.lbl_t.setWordWrap(True)
        self.lbl_t.setGeometry(22, 36, 270, 50)
        self.lbl_t.setAlignment(Qt.AlignLeft | Qt.AlignTop)
        qss = ("QPushButton{background:%s;border:1px solid rgba(255,255,255,50);border-radius:17px;color:#fff;font:700 9pt 'Segoe UI';"
               "letter-spacing:1px;min-height:34px;}QPushButton:hover{border-color:#e11d2e;}")
        self.b_play = QPushButton("PLAY NOW", self)
        self.b_play.setStyleSheet(qss % "#e11d2e")
        self.b_play.setGeometry(22, 98, 150, 34)
        self.b_cancel = QPushButton("CANCEL", self)
        self.b_cancel.setStyleSheet(qss % "rgba(255,255,255,18)")
        self.b_cancel.setGeometry(182, 98, 120, 34)
        for b in (self.b_play, self.b_cancel):
            b.setCursor(Qt.PointingHandCursor)
            b.setFocusPolicy(Qt.NoFocus)
        self.b_play.clicked.connect(self._play)
        self.b_cancel.clicked.connect(self._cancel)
        self.hide()

    def start(self, title, sub, seconds):
        self.total = self.left = max(1.0, float(seconds))
        self.lbl_t.setText(title)
        self.lbl_k.setText("UP NEXT" + ("  \u00b7  " + sub if sub else ""))
        self.show()
        self.raise_()
        self.t.start()
        self.update()

    def stop(self):
        self.t.stop()
        self.hide()

    def active(self):
        return self.isVisible() and self.t.isActive()

    def _step(self):
        self.left -= 0.05
        if self.left <= 0:
            self._play()
        else:
            self.update()

    def _play(self):
        if self.active():
            self.stop()
            self.play.emit()

    def _cancel(self):
        self.stop()
        self.cancel.emit()

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        p.setPen(QPen(LINE, 1))
        p.setBrush(PANEL)
        p.drawRoundedRect(QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5), 20, 20)
        ring = QRectF(self.width() - 76, 20, 54, 54)
        p.setBrush(Qt.NoBrush)
        p.setPen(QPen(QColor(255, 255, 255, 40), 4))
        p.drawEllipse(ring)
        p.setPen(QPen(ACCENT, 4, Qt.SolidLine, Qt.RoundCap))
        p.drawArc(ring, 90 * 16, int(-360 * 16 * (self.left / self.total)))
        p.setPen(QColor("#fff"))
        p.setFont(QFont("Segoe UI", 13, QFont.Bold))
        p.drawText(ring, Qt.AlignCenter, str(int(self.left) + 1 if self.left % 1 else int(self.left)))


class HeadphonesCard(QWidget):
    """Shown over the picture before a private video starts: put your headphones on. Sound only unlocks after the box is ticked."""
    choice = Signal(bool)                       # True = play with sound, False = play muted

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_NoMousePropagation, True)
        self.setMouseTracking(True)
        self.box = QWidget(self)
        self.box.setFixedSize(440, 262)
        self.box.setAttribute(Qt.WA_TranslucentBackground, True)
        self.lbl_k = QLabel("PRIVATE VIDEO", self.box)
        self.lbl_k.setStyleSheet("color:#e11d2e;font:800 9pt 'Segoe UI';letter-spacing:3px;background:transparent;")
        self.lbl_k.setGeometry(28, 22, 380, 18)
        self.lbl_t = QLabel("Put your headphones on", self.box)
        self.lbl_t.setStyleSheet("color:#fff;font:700 16pt 'Segoe UI';background:transparent;")
        self.lbl_t.setGeometry(28, 44, 390, 34)
        self.lbl_s = QLabel("Nothing plays until you choose. The sound stays off unless you confirm.", self.box)
        self.lbl_s.setStyleSheet("color:rgba(255,255,255,170);font:10pt 'Segoe UI';background:transparent;")
        self.lbl_s.setWordWrap(True)
        self.lbl_s.setGeometry(28, 82, 384, 38)
        self.chk = QCheckBox("I am wearing headphones", self.box)
        self.chk.setStyleSheet("QCheckBox{color:#fff;font:600 11pt 'Segoe UI';background:transparent;spacing:10px;}"
                               "QCheckBox::indicator{width:20px;height:20px;border-radius:5px;border:2px solid rgba(255,255,255,120);background:rgba(255,255,255,12);}"
                               "QCheckBox::indicator:checked{background:#e11d2e;border-color:#e11d2e;}")
        self.chk.setGeometry(28, 130, 384, 28)
        self.chk.setCursor(Qt.PointingHandCursor)
        self.chk.setFocusPolicy(Qt.NoFocus)
        qss = ("QPushButton{background:%s;border:1px solid rgba(255,255,255,50);border-radius:19px;color:#fff;font:700 10pt 'Segoe UI';"
               "min-height:38px;}QPushButton:hover:enabled{border-color:#e11d2e;}QPushButton:disabled{color:rgba(255,255,255,70);background:rgba(255,255,255,8);"
               "border-color:rgba(255,255,255,25);}")
        self.b_sound = QPushButton("Play with sound", self.box)
        self.b_sound.setStyleSheet(qss % "#e11d2e")
        self.b_sound.setGeometry(28, 188, 190, 38)
        self.b_muted = QPushButton("Play muted", self.box)
        self.b_muted.setStyleSheet(qss % "rgba(255,255,255,18)")
        self.b_muted.setGeometry(228, 188, 184, 38)
        for b in (self.b_sound, self.b_muted):
            b.setCursor(Qt.PointingHandCursor)
            b.setFocusPolicy(Qt.NoFocus)
        self.b_sound.setEnabled(False)
        self.chk.toggled.connect(self.b_sound.setEnabled)
        self.b_sound.clicked.connect(lambda: self._pick(True))
        self.b_muted.clicked.connect(lambda: self._pick(False))
        self.hide()

    def open(self, title=""):
        self.chk.setChecked(False)
        self.b_sound.setEnabled(False)
        self.show()
        self.raise_()
        self._place()
        self.update()

    def active(self):
        return self.isVisible()

    def _pick(self, sound):
        if sound and not self.chk.isChecked():
            return                                  # sound is only possible with the box ticked
        self.hide()
        self.choice.emit(bool(sound))

    def _place(self):
        self.box.move((self.width() - self.box.width()) // 2, max(10, (self.height() - self.box.height()) // 2))

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._place()

    def mousePressEvent(self, e):
        e.accept()                                  # the picture below must not react (no click-to-pause, no fullscreen toggle)

    def mouseDoubleClickEvent(self, e):
        e.accept()

    def wheelEvent(self, e):
        e.accept()

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        p.fillRect(self.rect(), QColor(0, 0, 0, 238))
        r = QRectF(self.box.geometry()).adjusted(0.5, 0.5, -0.5, -0.5)
        p.setPen(QPen(LINE, 1))
        p.setBrush(PANEL)
        p.drawRoundedRect(r, 22, 22)


MENU_QSS = ("QMenu{background:#121216;color:#eee;border:1px solid #2c2c34;border-radius:10px;padding:6px;font:10pt 'Segoe UI';}"
            "QMenu::item{padding:7px 26px 7px 22px;border-radius:6px;}QMenu::item:selected{background:#e11d2e;color:#fff;}"
            "QMenu::item:disabled{color:#888;}QMenu::separator{height:1px;background:#2c2c34;margin:6px 4px;}")


# ============================================================================= GL surface
class WinMedia:
    """Windows media overlay (the title in the volume flyout, headset and keyboard buttons). Optional: needs the 'winsdk' package;
    without it nothing happens and the plain media keys (RegisterHotKey, see Player.register_media_keys) still work."""

    def __init__(self, emit):
        self.ok = False
        if sys.platform != "win32":
            return
        try:
            from winsdk.windows.media import MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControlsButton as B
            from winsdk.windows.media.playback import MediaPlayer
            self.mp = MediaPlayer()
            self.mp.command_manager.is_enabled = False
            c = self.mp.system_media_transport_controls
            c.is_enabled = True
            for n in ("play", "pause", "next", "previous", "stop"):
                setattr(c, "is_%s_enabled" % n, True)
            names = {B.PLAY: "play", B.PAUSE: "pause", B.NEXT: "next", B.PREVIOUS: "prev", B.STOP: "stop"}
            c.add_button_pressed(lambda _s, a: emit(names.get(a.button, "")))
            self.c, self.T, self.S = c, MediaPlaybackType, MediaPlaybackStatus
            self.ok = True
        except Exception:
            log("windows media controls unavailable (pip install winsdk to enable):", traceback.format_exc(limit=1))

    def title(self, title, sub=""):
        if not self.ok:
            return
        try:
            u = self.c.display_updater
            u.type = self.T.VIDEO
            u.video_properties.title = title
            u.video_properties.subtitle = sub
            u.update()
        except Exception:
            log("media title failed", traceback.format_exc(limit=1))

    def playing(self, on):
        if self.ok:
            try:
                self.c.playback_status = self.S.PLAYING if on else self.S.PAUSED
            except Exception:
                pass

    def close(self):
        if self.ok:
            try:
                self.c.is_enabled = False
                self.mp.close()
            except Exception:
                pass


# ============================================================================= precision trimmer (scissors / T)
WINS = (4, 10, 30, 60, 120, 300, 900, 3600)                     # zoom steps: seconds of film shown across the strip
TICK_STEPS = (0.04, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800)


def tc_frames(t, fps):
    """h:mm:ss:ff timecode (ff = frame inside the second)."""
    if t is None:
        return "--:--:--:--"
    fps = fps if 1 < fps < 241 else 24.0
    t = max(0.0, float(t))
    whole = int(t + 1e-6)
    fr = min(int(round(fps)) - 1, int((t - whole) * fps + 1e-4))
    return "%d:%02d:%02d:%02d" % (whole // 3600, whole % 3600 // 60, whole % 60, max(0, fr))


def win_label(w):
    return "%d s" % w if w < 60 else ("%d min" % (w // 60) if w < 3600 else "1 hour")


class TrimStrip(QWidget):
    """The filmstrip of the visible stretch of film, a ruler, and an overview of the whole film underneath.
    Drag on the strip = scrub, drag the IN / OUT flags to trim, wheel = zoom, click the overview to jump."""
    scrub = Signal(float, bool)            # (seconds, final)
    handle = Signal(str, float, bool)      # ("in" | "out", seconds, final)
    zoom = Signal(int, float, float)       # (-1 in / +1 out, anchor seconds, fraction across the strip)
    jump = Signal(float)                   # overview click / drag: seconds
    PAD, STRIP_H, TICK_H, OV_H = 4, 64, 18, 16

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(self.STRIP_H + self.TICK_H + self.OV_H + 10)
        self.setMouseTracking(True)
        self.setCursor(Qt.PointingHandCursor)
        self.dur, self.t, self.ws, self.win, self.fps = 0.0, 0.0, 0.0, 60.0, 24.0
        self.a = self.b = None                       # IN / OUT in seconds
        self.pix, self.pix_span = None, (0.0, 0.0)   # filmstrip picture and the stretch of film it covers
        self.drag, self.hover = None, None

    def set_pix(self, pix, a, b):
        self.pix, self.pix_span = pix, (a, b)
        self.update()

    # ---- geometry
    def _w(self):
        return max(1.0, self.width() - 2.0 * self.PAD)

    def _x(self, t):
        return self.PAD + (t - self.ws) / self.win * self._w()

    def _t(self, x):
        return self.ws + max(0.0, min(1.0, (x - self.PAD) / self._w())) * self.win

    def _ov_top(self):
        return self.STRIP_H + self.TICK_H + 6

    def _ov_t(self, x):
        return max(0.0, min(1.0, (x - self.PAD) / self._w())) * self.dur

    def _visible(self, v):
        return v is not None and self.ws - 1e-3 <= v <= self.ws + self.win + 1e-3

    # ---- mouse
    def mousePressEvent(self, e):
        if e.button() != Qt.LeftButton:
            return
        x, y = e.position().x(), e.position().y()
        if y >= self._ov_top() - 2:
            if self.dur > 0:
                self.drag = "ov"
                self.jump.emit(self._ov_t(x))
            return
        self.drag = "seek"
        for name, v in (("in", self.a), ("out", self.b)):
            if self._visible(v) and abs(self._x(v) - x) <= 9:
                self.drag = name
        self._move(x, False)

    def _move(self, x, final):
        t = self._t(x)
        if self.dur > 0:
            t = max(0.0, min(self.dur, t))
        if self.drag == "seek":
            self.scrub.emit(t, final)
        elif self.drag in ("in", "out"):
            self.handle.emit(self.drag, t, final)

    def mouseMoveEvent(self, e):
        x, y = e.position().x(), e.position().y()
        self.hover = x if y < self.STRIP_H + self.TICK_H else None
        if self.drag == "ov":
            if self.dur > 0:
                self.jump.emit(self._ov_t(x))
        elif self.drag:
            self._move(x, False)
        self.update()

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.LeftButton and self.drag:
            if self.drag in ("seek", "in", "out"):
                self._move(e.position().x(), True)
            self.drag = None
            self.update()

    def leaveEvent(self, e):
        self.hover = None
        self.update()

    def wheelEvent(self, e):
        dy = e.angleDelta().y()
        e.accept()
        if dy == 0:
            return
        x = e.position().x()
        fr = max(0.0, min(1.0, (x - self.PAD) / self._w()))
        self.zoom.emit(-1 if dy > 0 else 1, self._t(x), fr)

    # ---- painting
    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        W, SH = self._w(), self.STRIP_H
        strip = QRectF(self.PAD, 0, W, SH)
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(0, 0, 0, 200))
        p.drawRoundedRect(strip, 6, 6)
        end = self.dur if self.dur > 0 else self.ws + self.win
        p.save()
        p.setClipRect(strip)
        if self.pix is not None and not self.pix.isNull() and self.pix_span[1] > self.pix_span[0]:
            x0, x1 = self._x(self.pix_span[0]), self._x(self.pix_span[1])
            p.drawPixmap(QRectF(x0, 0, max(1.0, x1 - x0), SH), self.pix, QRectF(self.pix.rect()))
        else:
            p.setPen(DIM)
            p.setFont(QFont("Segoe UI", 9))
            p.drawText(strip, Qt.AlignCenter, "Loading frames\u2026" if self.dur > 0 else "")
        if self.dur > 0 and self.ws + self.win > end:                        # nothing after the last frame
            p.fillRect(QRectF(self._x(end), 0, W, SH), QColor(0, 0, 0, 215))
        p.restore()
        if self.a is not None and self.b is not None and self.b > self.a:     # the part that will be saved
            l, r = max(self._x(self.a), self.PAD), min(self._x(self.b), self.PAD + W)
            if r > l:
                p.setPen(Qt.NoPen)
                p.setBrush(QColor(225, 29, 46, 70))
                p.drawRect(QRectF(l, 0, r - l, SH))
                p.setPen(QPen(QColor(225, 29, 46, 230), 2))
                p.drawLine(QPointF(l, 1), QPointF(r, 1))
                p.drawLine(QPointF(l, SH - 1), QPointF(r, SH - 1))
        # ruler
        want = self.win / 8.0
        st = next((s for s in TICK_STEPS if s >= want), 1800)
        p.setFont(QFont("Consolas", 8))
        k = int(self.ws / st) + (0 if self.ws % st == 0 else 1)
        while k * st < self.ws + self.win + 1e-9:
            tt = round(k * st, 3)
            x = self._x(tt)
            p.setPen(QPen(QColor(255, 255, 255, 90), 1))
            p.drawLine(QPointF(x, SH), QPointF(x, SH + 5))
            if tt >= 3600:
                lab = "%d:%02d:%02d" % (tt // 3600, tt % 3600 // 60, tt % 60)
            elif tt >= 60:
                lab = "%d:%02d" % (tt // 60, tt % 60)
            else:
                lab = ("%.2fs" % tt) if st < 1 else ("%ds" % tt)
            p.setPen(QColor(255, 255, 255, 140))
            p.drawText(QRectF(x - 30, SH + 4, 60, 14), Qt.AlignHCenter | Qt.AlignVCenter, lab)
            k += 1
        # IN / OUT flags
        p.setFont(QFont("Segoe UI", 7, QFont.Bold))
        for name, v in (("IN", self.a), ("OUT", self.b)):
            if not self._visible(v):
                continue
            x = self._x(v)
            p.setPen(QPen(QColor("#ffffff"), 2))
            p.drawLine(QPointF(x, 0), QPointF(x, SH))
            fw = 28 if name == "IN" else 32
            fx = x if name == "IN" else x - fw
            p.setPen(Qt.NoPen)
            p.setBrush(ACCENT)
            p.drawRoundedRect(QRectF(fx, 2, fw, 13), 3, 3)
            p.setPen(QColor("#ffffff"))
            p.drawText(QRectF(fx, 2, fw, 13), Qt.AlignCenter, name)
        # playhead
        if self._visible(self.t):
            x = self._x(self.t)
            p.setPen(QPen(QColor("#ffffff"), 2))
            p.drawLine(QPointF(x, 0), QPointF(x, SH + 2))
            p.setPen(Qt.NoPen)
            p.setBrush(QColor("#ffffff"))
            p.drawPolygon(QPolygonF([QPointF(x - 5, 0), QPointF(x + 5, 0), QPointF(x, 7)]))
        # hover time
        if self.hover is not None:
            tt = self._t(self.hover)
            lab = tc_frames(tt, self.fps)
            p.setFont(QFont("Consolas", 8, QFont.Bold))
            bw = 78
            bx = max(self.PAD, min(self.PAD + W - bw, self.hover - bw / 2))
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(0, 0, 0, 215))
            p.drawRoundedRect(QRectF(bx, SH - 20, bw, 16), 4, 4)
            p.setPen(QColor("#ffffff"))
            p.drawText(QRectF(bx, SH - 20, bw, 16), Qt.AlignCenter, lab)
        # overview of the whole film
        if self.dur > 0:
            oy = self._ov_top()
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(255, 255, 255, 40))
            p.drawRoundedRect(QRectF(self.PAD, oy + 4, W, self.OV_H - 8), 3, 3)
            if self.a is not None and self.b is not None and self.b > self.a:
                p.setBrush(QColor(225, 29, 46, 200))
                p.drawRect(QRectF(self.PAD + self.a / self.dur * W, oy + 4, max(2.0, (self.b - self.a) / self.dur * W), self.OV_H - 8))
            p.setBrush(Qt.NoBrush)
            p.setPen(QPen(QColor(255, 255, 255, 190), 1.5))
            wx, ww = self.PAD + self.ws / self.dur * W, min(1.0, self.win / self.dur) * W
            p.drawRoundedRect(QRectF(wx, oy + 1, max(4.0, ww), self.OV_H - 2), 3, 3)
            p.setPen(QPen(QColor("#ffffff"), 2))
            px = self.PAD + max(0.0, min(1.0, self.t / self.dur)) * W
            p.drawLine(QPointF(px, oy), QPointF(px, oy + self.OV_H))


TBTN_QSS = ("QPushButton{background:rgba(255,255,255,18);border:1px solid rgba(255,255,255,40);border-radius:8px;color:#fff;"
            "padding:0 10px;font:700 9pt 'Segoe UI';min-height:26px;}"
            "QPushButton:hover{border-color:#e11d2e;background:rgba(225,29,46,60);}"
            "QPushButton:checked{background:rgba(225,29,46,150);border-color:#e11d2e;}"
            "QPushButton:disabled{color:rgba(255,255,255,90);border-color:rgba(255,255,255,20);}")


def _tbtn(text, tip="", checkable=False):
    b = QPushButton(text)
    b.setToolTip(tip)
    b.setCheckable(checkable)
    b.setCursor(Qt.PointingHandCursor)
    b.setFocusPolicy(Qt.NoFocus)
    b.setStyleSheet(TBTN_QSS)
    return b


def _lbl(text, css):
    l = QLabel(text)
    l.setStyleSheet(css + "background:transparent;")
    return l


class TrimPanel(Panel):
    """Sits above the control bar: IN / OUT, the filmstrip, frame stepping and Save clip."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(214)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(18, 10, 18, 10)
        lay.setSpacing(6)
        dim = "color:rgba(255,255,255,140);font:8pt 'Segoe UI';font-weight:700;letter-spacing:1px;"
        val = "color:#fff;font:10pt 'Consolas';"
        head = QHBoxLayout()
        head.setSpacing(6)
        head.addWidget(_lbl("PRECISION", "color:#ff4d5e;font:700 10pt 'Segoe UI';letter-spacing:3px;"))
        head.addSpacing(10)
        self.l_in, self.l_out, self.l_len = _lbl("--", val), _lbl("--", val), _lbl("--", val)
        for cap, w in (("IN", self.l_in), ("OUT", self.l_out), ("LEN", self.l_len)):
            head.addWidget(_lbl(cap, dim))
            head.addWidget(w)
            head.addSpacing(6)
        head.addStretch(1)
        self.b_in = _tbtn("IN", "Set IN at the playhead (I)")
        self.b_out = _tbtn("OUT", "Set OUT at the playhead (O)")
        self.b_goin = _tbtn("GO IN", "Jump to IN")
        self.b_goout = _tbtn("GO OUT", "Jump to OUT")
        self.b_range = _tbtn("\u25B6 A\u2013B", "Play the part between IN and OUT")
        self.b_loop = _tbtn("LOOP", "On: loop the part. Off: stop at OUT", True)
        self.b_clear = _tbtn("CLEAR", "Clear IN and OUT (\\)")
        self.b_save = _tbtn("SAVE CLIP", "Save the part as its own file in Videos/Clips (no re-encoding: the cut starts at the keyframe before IN)")
        self.b_zout = _tbtn("\u2212", "Zoom out (wheel on the strip)")
        self.l_win = _lbl("1 min", val)
        self.b_zin = _tbtn("+", "Zoom in")
        self.b_x = _tbtn("\u00d7", "Close (T)")
        for w in (self.b_in, self.b_out, self.b_goin, self.b_goout, self.b_range, self.b_loop, self.b_clear, self.b_save):
            head.addWidget(w)
        head.addSpacing(10)
        for w in (self.b_zout, self.l_win, self.b_zin):
            head.addWidget(w)
        head.addSpacing(6)
        head.addWidget(self.b_x)
        lay.addLayout(head)
        self.strip = TrimStrip()
        lay.addWidget(self.strip)
        foot = QHBoxLayout()
        foot.setSpacing(6)
        self.l_tc = _lbl("0:00:00:00", "color:#fff;font:10pt 'Consolas';")
        foot.addWidget(self.l_tc)
        foot.addSpacing(14)
        self.steps = []
        for text, kind, n, tip in (("\u22121 s", "s", -1, "Back 1 second"), ("\u221210 f", "f", -10, "Back 10 frames"), ("\u22121 f", "f", -1, "Back one frame (,)"),
                                   ("+1 f", "f", 1, "Forward one frame (.)"), ("+10 f", "f", 10, "Forward 10 frames"), ("+1 s", "s", 1, "Forward 1 second")):
            b = _tbtn(text, tip)
            foot.addWidget(b)
            self.steps.append((b, kind, n))
        foot.addStretch(1)
        foot.addWidget(_lbl("Drag on the strip to scrub \u00b7 drag the IN / OUT flags \u00b7 wheel zooms", "color:rgba(255,255,255,110);font:8pt 'Segoe UI';"))
        lay.addLayout(foot)

    def refresh(self, t, d, a, b, fps, loop):
        s = self.strip
        s.t, s.dur, s.a, s.b, s.fps = t, d, a, b, fps
        s.update()
        self.l_in.setText(tc_frames(a, fps) if a is not None else "--")
        self.l_out.setText(tc_frames(b, fps) if b is not None else "--")
        self.l_len.setText("%.2f s" % (b - a) if (a is not None and b is not None) else "--")
        if self.b_loop.isChecked() != loop:
            self.b_loop.setChecked(loop)
        self.l_tc.setText("%s   /   %s" % (tc_frames(t, fps), tc_frames(d, fps)))
        self.l_win.setText(win_label(s.win))

    def wheelEvent(self, e):
        e.accept()


class Bus(QObject):
    update = Signal()
    session = Signal(object)
    toast = Signal(str)
    thumb = Signal(int, int, bytes)
    sub_file = Signal(str, str, bool)      # path, title, select
    ai = Signal(str)
    fail = Signal(str)
    media = Signal(str)                   # play / pause / next / prev / stop from the Windows media controls
    strip = Signal(int, float, float, bytes)   # trimmer filmstrip: (generation, from, to, jpeg)
    clip_done = Signal()                  # the trimmer's Save clip finished (ok or not)
    remote = Signal(str, object)          # a command from the phone remote (see remote.py)


class Stage(QOpenGLWidget):
    def __init__(self, player):
        super().__init__()
        self.pl = player
        self.rctx = None
        self.proc_fn = None
        self.setMouseTracking(True)
        self._warned = False
        self._click = QTimer(self)
        self._click.setSingleShot(True)
        self._click.timeout.connect(self.pl.toggle_pause)

    def initializeGL(self):
        try:
            self.pl.init_render(self)
        except Exception:
            log("render init failed:\n" + traceback.format_exc())
            self.pl.bus.fail.emit("render")

    def paintGL(self):
        if self.rctx is None:
            return
        try:
            dpr = self.devicePixelRatioF()
            self.rctx.update()                                   # tell mpv we handled its "new frame" notice
            self.rctx.render(opengl_fbo={"w": int(self.width() * dpr), "h": int(self.height() * dpr),
                                         "fbo": int(self.defaultFramebufferObject())}, flip_y=True, block_for_target_time=False)
        except Exception:
            if not self._warned:
                self._warned = True
                log("render failed:\n" + traceback.format_exc())

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            self._press = e.position()
            self._moved = False
        elif e.button() == Qt.RightButton:
            self.pl.toggle_pause()

    def mouseMoveEvent(self, e):
        if (e.buttons() & Qt.LeftButton) and getattr(self, "_press", None) is not None:
            d = e.position() - self._press
            if self.pl.zoom > 0.001 and (self._moved or abs(d.x()) + abs(d.y()) > 4):      # drag = pan, only while zoomed in
                self._moved = True
                self.pl.pan_by(d.x(), d.y())
                self._press = e.position()

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.LeftButton and getattr(self, "_press", None) is not None:
            self._press = None
            if not self._moved:
                self._click.start(260)       # a second click inside this time is a double click = fullscreen

    def mouseDoubleClickEvent(self, e):
        self._click.stop()
        self.pl.toggle_fullscreen()

    def wheelEvent(self, e):
        if self.pl.mini:
            up = e.angleDelta().y() > 0                                   # mini player: wheel seeks, Ctrl + wheel = volume
            self.pl.add_volume(3 if up else -3) if e.modifiers() & Qt.ControlModifier else self.pl.seek_rel(5 if up else -5)
        elif e.modifiers() & Qt.ControlModifier:
            self.pl.zoom_by(0.1 if e.angleDelta().y() > 0 else -0.1)
        else:
            self.pl.add_volume(3 if e.angleDelta().y() > 0 else -3)


# ============================================================================= the window
class Player(QMainWindow):
    def __init__(self, args, api, mod, sess):
        super().__init__()
        self.args, self.api, self.mod = args, api, mod
        self.sess = sess
        self.vid = str(args.vid)
        self.bus = Bus()
        self.st = {"t": 0.0, "dur": 0.0, "pause": True, "vol": 80.0, "mute": False, "speed": 1.0, "eof": False, "cache": 0.0,
                   "w": 0, "h": 0, "fmt": "", "buffering": False, "loaded": False}
        self.m = None
        self.ready = False
        self.gen = 0                      # bumped for every video: stale thumbnail / subtitle results are dropped
        self.thumbs, self.thumb_n, self.thumb_chunks = {}, 40, 4
        self.sub_loaded = {}              # AI target -> created stamp already added to mpv
        self.ai_job = ""
        self.resumed = False
        self.counted = False
        self.last_save = 0.0
        self.last_move = time.time()
        self.menu_open = False
        self.ui_on = True
        self._was_max = True
        self.closing = False
        self.lift_applied = None
        self.ab = [None, None]                 # A-B loop points in seconds (also the trimmer's IN / OUT)
        self.ab_loop = True                    # A-B part loops (False: plays once and stops at B when started from the trimmer)
        self._range_stop = None                # seconds: pause here (trimmer A-B play with LOOP off)
        self.trim_open, self._strip_key, self._strip_fail, self._saving, self._fps = False, None, 0.0, False, 24.0
        self.mini, self._pre = False, None     # mini player: small always-on-top window; what to go back to
        self._hotkeys = []
        self.lights = 0                        # 0 normal, 1 theater (controls hide fast, see-through bar), 2 night (theater + dimmer picture)
        self.hints_shown = False
        self.auto_muted = False                                  # the current video was muted by the private-video rule
        self._beat_at = 0.0                                      # last "a private video is playing" heartbeat sent to the app
        self.chapters, self._chap_gen = [], -1  # [(seconds, title)] of the current file
        self._card_gen = -1                    # session generation the title card was already shown for
        self.sleep_at, self.sleep_eov, self.sleep_base = None, False, None      # sleep timer: deadline (time.time), stop after this video, volume before the fade
        self.fit, self.zoom, self.pan, self.aspect = "fit", 0.0, [0.0, 0.0], "-1"      # picture: fit|fill, video-zoom (log2), video-pan x/y, aspect override

        self.setWindowTitle("ULTRON")
        self.setStyleSheet("QMainWindow{background:#000;}")
        self._icon()
        self.stage = Stage(self)
        self.setCentralWidget(self.stage)
        self._build_overlay()
        self.bus.update.connect(self.stage.update)
        self.bus.session.connect(self.open_session)
        self.bus.toast.connect(self.toast.say)
        self.bus.thumb.connect(self.on_thumb)
        self.bus.sub_file.connect(self.on_sub_file)
        self.bus.ai.connect(self.on_ai)
        self.bus.fail.connect(self.on_fail)
        self.bus.media.connect(self.on_media)
        self.bus.strip.connect(self.on_strip)
        self.bus.clip_done.connect(self.on_clip_done)
        self.bus.remote.connect(self.on_remote)
        self._remote_on, self._remote_at = False, 0.0
        threading.Thread(target=self._remote_loop, daemon=True).start()
        self.winmedia = WinMedia(self.bus.media.emit)
        self._media_last = None

        self.tick_t = QTimer(self)
        self.tick_t.timeout.connect(self.tick)
        self.tick_t.start(120)
        self.stage.installEventFilter(self)
        QApplication.instance().installEventFilter(self)

    # ---- window bits
    def _icon(self):
        for n in ("logo.png", "icon.png"):
            for d in (APP_DIR, Path(getattr(sys, "_MEIPASS", APP_DIR))):
                try:
                    if (d / n).is_file():
                        self.setWindowIcon(QIcon(str(d / n)))
                        return
                except OSError:
                    pass

    def dark_titlebar(self):
        if os.name != "nt":
            return
        try:
            hwnd = int(self.winId())
            v = ctypes.c_int(1)
            for attr in (20, 19):                                  # DWMWA_USE_IMMERSIVE_DARK_MODE (new / old id)
                ctypes.windll.dwmapi.DwmSetWindowAttribute(ctypes.c_void_p(hwnd), attr, ctypes.byref(v), ctypes.sizeof(v))
        except Exception:
            log("dark title bar failed", traceback.format_exc())

    # ---- overlay widgets
    def _build_overlay(self):
        s = self.stage
        self.top = TopFade(s)
        tl = QHBoxLayout(self.top)
        tl.setContentsMargins(26, 18, 26, 34)
        tl.setSpacing(12)
        self.btn_back = Pill("   BACK")
        self.btn_back.clicked.connect(self.close)
        self.btn_start = Pill("START OVER")
        self.btn_start.clicked.connect(lambda: self.seek_abs(0, True))
        tl.addWidget(self.btn_back, 0, Qt.AlignTop)
        tl.addWidget(self.btn_start, 0, Qt.AlignTop)
        tl.addSpacing(10)
        col = QVBoxLayout()
        col.setSpacing(0)
        self.lbl_sub = QLabel("")
        self.lbl_sub.setStyleSheet("color:rgba(255,255,255,170);font:10pt 'Segoe UI';background:transparent;")
        self.lbl_title = QLabel("")
        self.lbl_title.setStyleSheet("color:#fff;font:600 17pt 'Segoe UI';background:transparent;")
        col.addWidget(self.lbl_sub)
        col.addWidget(self.lbl_title)
        tl.addLayout(col, 0)
        self.b_rename = IconButton("pencil", "Rename title (F2)", 34)
        self.b_rename.clicked.connect(self.rename_title)
        tl.addWidget(self.b_rename, 0, Qt.AlignTop)
        tl.addStretch(1)
        self.stars = StarBar()
        self.stars.rated.connect(self.rate)
        tl.addWidget(self.stars, 0, Qt.AlignTop)
        self.lbl_info = QLabel("")
        self.lbl_info.setStyleSheet("color:rgba(255,255,255,130);font:9pt 'Consolas';background:transparent;")
        tl.addWidget(self.lbl_info, 0, Qt.AlignTop | Qt.AlignRight)

        self.bar = Panel(s)
        bl = QVBoxLayout(self.bar)
        bl.setContentsMargins(24, 10, 24, 8)
        bl.setSpacing(2)
        self.seek = SeekBar()
        self.seek.seeked.connect(self.on_seek_bar)
        self.seek.hovered.connect(self.on_seek_hover)
        bl.addWidget(self.seek)
        row = QHBoxLayout()
        row.setSpacing(2)
        bl.addLayout(row)
        self.b_play = IconButton("play", "Play / pause (Space)", 48)
        self.b_play.clicked.connect(self.toggle_pause)
        self.b_play.accent = True                                     # Ultron look: the play / pause triangle is red
        self.b_prev = IconButton("prev", "Previous episode (P)")
        self.b_prev.clicked.connect(lambda: self.goto(self.sess.get("prev")))
        self.b_back = IconButton("back10", "Back 10 s (J)")
        self.b_back.clicked.connect(lambda: self.seek_rel(-10))
        self.b_fwd = IconButton("fwd10", "Forward 10 s (L)")
        self.b_fwd.clicked.connect(lambda: self.seek_rel(10))
        self.b_next = IconButton("next", "Next episode (N)")
        self.b_next.clicked.connect(lambda: self.goto(self.sess.get("next")))
        self.b_vol = IconButton("vol", "Mute (M)")
        self.b_vol.clicked.connect(self.toggle_mute)
        self.vol = VolumeBar()
        self.vol.changed.connect(self.set_volume)
        self.lbl_time = QLabel("0:00 / 0:00")
        self.lbl_time.setStyleSheet("color:rgba(255,255,255,170);font:10pt 'Consolas';background:transparent;padding-left:10px;")
        self.b_audio = IconButton("audio", "Audio track")
        self.b_audio.clicked.connect(self.menu_audio)
        self.b_cc = IconButton("cc", "Subtitles (C)")
        self.b_cc.clicked.connect(self.menu_subs)
        self.b_speed = IconButton("", "Speed", 40, "1x")
        self.b_speed.clicked.connect(self.menu_speed)
        self.b_lights = IconButton("bulb", "Lights: theater / night (D)")
        self.b_lights.clicked.connect(self.cycle_lights)
        self.b_ab = IconButton("", "A-B loop (B): set A, set B, clear", 40, "A-B")
        self.b_ab.clicked.connect(self.ab_cycle)
        self.b_trim = IconButton("scissors", "Precision trimmer: filmstrip, IN / OUT, save clip (T)")
        self.b_trim.clicked.connect(self.toggle_trim)
        self.b_sleep = IconButton("moon", "Sleep timer")
        self.b_sleep.clicked.connect(self.menu_sleep)
        self.b_pic = IconButton("fit", "Picture: fit / fill, aspect ratio, zoom (A)")
        self.b_pic.clicked.connect(self.menu_picture)
        self.b_shot = IconButton("cam", "Screenshot (S)")
        self.b_shot.clicked.connect(self.screenshot)
        self.b_mini = IconButton("mini", "Mini player (E)")
        self.b_mini.clicked.connect(self.toggle_mini)
        self.b_fs = IconButton("fs", "Fullscreen (F)")
        self.b_fs.clicked.connect(self.toggle_fullscreen)
        for w in (self.b_play, self.b_prev, self.b_back, self.b_fwd, self.b_next, self.b_vol, self.vol, self.lbl_time):
            row.addWidget(w, 0, Qt.AlignVCenter)
        row.addStretch(1)
        for w in (self.b_audio, self.b_cc, self.b_speed, self.b_ab, self.b_trim, self.b_pic, self.b_lights, self.b_sleep, self.b_shot, self.b_mini, self.b_fs):
            row.addWidget(w, 0, Qt.AlignVCenter)
        self.trim = TrimPanel(s)
        self.trim.hide()
        t = self.trim
        t.b_in.clicked.connect(self.trim_set_in)
        t.b_out.clicked.connect(self.trim_set_out)
        t.b_goin.clicked.connect(lambda: self.trim_go(0))
        t.b_goout.clicked.connect(lambda: self.trim_go(1))
        t.b_range.clicked.connect(self.trim_range_play)
        t.b_loop.clicked.connect(self.trim_loop_toggle)
        t.b_clear.clicked.connect(self.trim_clear)
        t.b_save.clicked.connect(self.trim_save)
        t.b_zin.clicked.connect(lambda: self.trim_zoom(-1))
        t.b_zout.clicked.connect(lambda: self.trim_zoom(1))
        t.b_x.clicked.connect(self.close_trim)
        t.strip.scrub.connect(lambda x, fin: self.seek_abs(x, fin))
        t.strip.handle.connect(self.trim_handle)
        t.strip.zoom.connect(self.trim_zoom)
        t.strip.jump.connect(self.trim_jump)
        for b, kind, n in t.steps:
            b.clicked.connect(lambda _=False, k=kind, n=n: self.trim_step(k, n))
        self.preview = Preview(s)
        self.toast = Toast(s)
        self.tcard = TitleCard(s)
        self.hints = HintsCard(s)
        self.upnext = UpNextCard(s)
        self.hp = HeadphonesCard(s)
        self.hp.choice.connect(self.hp_choice)
        self.upnext.play.connect(self.upnext_go)
        self.upnext.cancel.connect(lambda: self.toast.say("Autoplay cancelled", 1400))
        self.layout_overlay()

    def layout_overlay(self):
        w, h = self.stage.width(), self.stage.height()
        self.top.setGeometry(0, 0, w, 130)
        bw = max(320, w - 64)
        bh = 92
        self.bar.setGeometry((w - bw) // 2, h - bh - 22, bw, bh)
        th = self.trim.height()
        self.trim.setGeometry((w - bw) // 2, max(60, h - bh - 22 - th - 10), bw, th)
        self.hints.setGeometry(0, 0, w, h)
        self.tcard.setGeometry(0, 0, w, h)
        self.tcard.raise_()
        self.top.raise_()
        self.bar.raise_()
        self.trim.raise_()
        self.preview.raise_()
        self.toast.raise_()
        self.upnext.move(w - self.upnext.width() - 32, h - bh - 22 - self.upnext.height() - 14)
        self.upnext.raise_()
        self.hp.setGeometry(0, 0, w, h)
        if self.hp.isVisible():
            self.hp.raise_()
        self.toast.raise_()
        if self.hints.isVisible():
            self.hints.raise_()

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self.layout_overlay()

    # ---- overlay visibility (autohide)
    def set_ui(self, on):
        if on == self.ui_on:
            return
        self.ui_on = on
        self.top.setVisible(on and not self.mini)
        self.bar.setVisible(on)
        self.trim_vis()
        if not on:
            self.preview.hide()
        self.stage.setCursor(Qt.ArrowCursor if on else Qt.BlankCursor)
        self.apply_lift()

    def apply_lift(self):
        """Subtitles sit above the control bar while it shows (mpv's margin counts in a 720-line scale)."""
        if self.m is None:
            return
        h = self.stage.height()
        if h < 240:                                                   # still opening / tiny window: nothing sensible to compute yet
            return
        lift = self.bar.height() + 22 + (self.trim.height() + 10 if self.trim.isVisible() else 0)
        want = 22 + (int(round(lift / h * 720)) if self.ui_on else 0)
        want = max(22, min(500, want))                                # mpv refuses anything above 600
        if want == self.lift_applied:
            return
        try:
            self.m["sub-margin-y"] = want
            self.lift_applied = want
        except Exception:
            log("sub-margin-y failed", traceback.format_exc())

    def eventFilter(self, obj, ev):
        t = ev.type()
        if t in (QEvent.MouseMove, QEvent.MouseButtonPress, QEvent.Wheel):
            self.last_move = time.time()
            if not self.ui_on:
                self.set_ui(True)
        return False

    # ---- mpv
    def start_mpv(self):
        pr = self.sess.get("prefs") or {}
        o = mpv_backend.build_options(pr, "stage", "ULTRON-native", "", None)
        for k in ("gpu-api", "gpu-context", "force-window", "cursor-autohide", "wid"):
            o.pop(k, None)
        hw = str(o.get("hwdec") or "auto")
        o.update({"vo": "libmpv", "osc": "no", "input-default-bindings": "no", "input-vo-keyboard": "no", "input-cursor": "no",
                  "video-sync": "audio", "interpolation": "no", "idle": "yes", "keep-open": "yes",
                  "hwdec": "d3d11va-copy" if hw in ("d3d11va", "auto", "auto-safe") and os.name == "nt" else hw,
                  "config-dir": str(Path(self.sess.get("data_dir") or (APP_DIR / "data")) / "mpv")})
        Path(o["config-dir"]).mkdir(parents=True, exist_ok=True)
        last = None
        for attempt in (o, dict(mpv_backend.safe_options(o), vo="libmpv", hwdec="auto-copy")):
            try:
                self.m = self.mod.MPV(log_handler=self._on_log, loglevel="warn", **{k.replace("-", "_"): v for k, v in attempt.items()})
                break
            except Exception as e:
                last = e
                log("mpv start failed, retrying with the safe set:", e)
        if self.m is None:
            raise RuntimeError("mpv could not start: %s" % last)
        for k, v in (("sub-back-color", "#00000000"), ("sub-shadow-offset", "1"), ("sub-border-style", "outline-and-shadow"),
                     ("osd-level", "0")):
            try:
                self.m[k] = v
            except Exception:
                pass
        m = self.m
        for prop, key, conv in (("duration", "dur", float), ("pause", "pause", bool), ("volume", "vol", float), ("mute", "mute", bool),
                                ("speed", "speed", float), ("eof-reached", "eof", bool), ("paused-for-cache", "buffering", bool)):
            m.observe_property(prop, self._putter(key, conv))
        m.observe_property("time-pos", self._putter("t", float))
        m.observe_property("demuxer-cache-time", self._putter("cache", float))
        m.observe_property("video-params", self._on_params)
        m.observe_property("video-format", self._putter("fmt", str))
        self._pick_audio_device(pr)

        @m.event_callback("file-loaded")
        def _loaded(_ev):
            self.st["loaded"] = True
            try:
                m["start"] = "none"
            except Exception:
                pass

    def _putter(self, key, conv):
        def cb(_n, v):
            if v is None:
                return
            try:
                self.st[key] = conv(v)
            except Exception:
                pass
        return cb

    def _on_params(self, _n, v):
        if isinstance(v, dict):
            self.st["w"], self.st["h"] = int(v.get("dw") or v.get("w") or 0), int(v.get("dh") or v.get("h") or 0)

    def _on_log(self, level, prefix, text):
        if level in ("error", "fatal"):
            log("mpv [%s] %s" % (prefix, str(text).strip()))

    def _pick_audio_device(self, pr):
        want = str(pr.get("mpv_audio_device") or "").strip().lower()
        if not want or self.m is None:
            return
        try:
            for d in self.m.audio_device_list or []:
                if want in str(d.get("description", "")).lower() or want in str(d.get("name", "")).lower():
                    self.m["audio-device"] = d["name"]
                    return
        except Exception:
            log("audio device pick failed", traceback.format_exc())

    def init_render(self, stage):
        """Called once the GL context exists: create the mpv render context and start the first file."""
        def get_proc(_ctx, name):
            gl = QOpenGLContext.currentContext()
            if gl is None:
                return 0
            try:
                a = gl.getProcAddress(name)
                return ctypes.cast(int(a), ctypes.c_void_p).value if a else 0
            except Exception:
                return 0
        self.start_mpv()
        stage.proc_fn = self.mod.MpvGlGetProcAddressFn(get_proc)
        stage.rctx = self.mod.MpvRenderContext(self.m, "opengl", opengl_init_params={"get_proc_address": stage.proc_fn})
        stage.rctx.update_cb = lambda: self.bus.update.emit()
        self.ready = True
        # open the file a moment after the surface exists (not from inside initializeGL), so the first frame lands on a settled framebuffer
        QTimer.singleShot(350, lambda: self.open_session(self.sess))

    # ---- sessions (one video; the next episode is another session)
    def open_session(self, sess):
        if not self.ready or self.m is None:
            return
        self.sess = sess
        self.vid = str(sess.get("id") or self.vid)
        self.gen += 1
        self.upnext.stop()
        self.tcard.stop()
        self.stars.set_value(sess.get("user_rating") or 0)
        self.thumbs.clear()
        self.sub_loaded.clear()
        self.ai_job = ""
        self.counted = False
        self.close_trim()
        self.trim.strip.set_pix(None, 0.0, 0.0)
        self._strip_key, self._range_stop, self._fps = None, None, 24.0
        self.b_trim.setVisible(not self.mini and not sess.get("private"))
        self.last_save = time.time()
        self.st.update(eof=False, t=0.0, loaded=False)
        pr = sess.get("prefs") or {}
        resume = float(sess.get("resume") or 0)
        self.resumed = resume > 0
        self.btn_start.setVisible(self.resumed)
        title = sess.get("title") or Path(sess.get("path", "")).stem
        self.lbl_title.setText(title)
        self.lbl_sub.setText("%s \u2022 Episode %s of %s" % (sess["series"], sess["index"], sess["total"]) if sess.get("series") else "")
        self.setWindowTitle("%s \u2014 ULTRON" % title)
        self.winmedia.title(title, ("%s \u2022 Episode %s" % (sess["series"], sess["index"])) if sess.get("series") else "")
        if not self.mini:
            self.b_prev.setVisible(bool(sess.get("prev")))
            self.b_next.setVisible(bool(sess.get("next")))
        try:
            self.m["volume"] = float(pr.get("default_volume", 80))
            quiet = bool(sess.get("private")) and pr.get("private_start_muted", True) is not False
            if quiet:
                self.m["mute"] = True                    # private videos start muted (M gives the sound back)
            elif self.auto_muted:
                self.m["mute"] = False                   # the last video was muted by this rule, not by you: give the sound back
            self.auto_muted = quiet
            self.m["speed"] = float(pr.get("default_speed", 1.0))
            self.m["sub-scale"] = max(0.3, min(3.0, int(pr.get("subs_size") or 100) / 100.0))
            self.m["sid"] = "no"
            self.reset_picture(pr.get("default_fit") or "fit", quiet=True)
            self.chapters = []
            self.seek.chapters = []
            self.apply_sub_style(pr)
            self.ab = [None, None]
            self.m["ab-loop-a"] = "no"
            self.m["ab-loop-b"] = "no"
            self.m["start"] = ("%.2f" % resume) if resume > 1 else "none"
            gate = bool(sess.get("private")) and bool(sess.get("hp_prompt"))
            if gate:
                self.m["mute"] = True                    # nothing is heard until the prompt is answered
            self.m.play(str(sess["path"]))
            self.m["pause"] = gate
        except Exception:
            log("load failed:\n" + traceback.format_exc())
            self.toast.say("Could not open this file")
            return
        self.start_thumbs()
        threading.Thread(target=self.load_subs, args=(self.gen,), daemon=True).start()
        if gate:
            self.auto_muted = True
            self.hp.open(title)
        elif self.auto_muted:
            self.toast.say("Private video starts muted \u2022 Press M for sound", 4000)

    def hp_choice(self, sound):
        """The headphones prompt was answered: start the video with or without sound, and remember the answer for this unlock."""
        if self.m is None:
            return
        try:
            self.m["mute"] = not sound
            self.auto_muted = not sound
            self.m["pause"] = False
        except Exception:
            log("headphones choice failed:\n" + traceback.format_exc())
        if not sound:
            self.toast.say("Playing muted \u2022 Press M for sound", 3500)

        def work():
            try:
                self.api.post_json("/api/private/headphones/ack", {})
            except Exception:
                log("headphones ack failed:\n" + traceback.format_exc())
        threading.Thread(target=work, daemon=True).start()

    # ---- subtitles
    def load_subs(self, gen):
        """External subtitle files + AI tracks made earlier are downloaded to temp files and handed to mpv."""
        import urllib.error
        pr = self.sess.get("prefs") or {}
        first = True
        for s in self.sess.get("subtitles") or []:
            if gen != self.gen:
                return
            self.fetch_sub(s.get("url"), s.get("label") or "Subtitles", s.get("lang") or "", first and bool(pr.get("subs_auto", True)), gen)
            first = False
        if pr.get("asub_enabled", True) is False:
            return
        try:
            d = self.api.get_json("/api/videos/%s/autosubs" % self.vid)
        except Exception:
            return
        want = str(pr.get("asub_lang") or "en")
        pick = None
        for t in d.get("tracks") or []:
            if gen != self.gen:
                return
            self.fetch_sub(t.get("url"), t.get("label") or "Subtitles (AI)", t.get("lang") or "", False, gen, stamp=(t["target"], t.get("created")))
            if t.get("target") == want:
                pick = t
        if pick and first and pr.get("subs_auto", True):
            self.bus.ai.emit("select:" + pick["target"])
        active = [j for j in d.get("jobs") or [] if j.get("state") in ("queued", "running")]
        if active:
            self.watch_ai(gen)

    def fetch_sub(self, url, title, lang, select, gen, stamp=None):
        if not url:
            return
        try:
            raw = self.api.get_bytes(url)
            suffix = ".vtt" if raw[:6] == b"WEBVTT" or b"-->" in raw[:400] else ".srt"
            f = Path(tempfile.gettempdir()) / ("ultron_sub_%s_%d%s" % (self.vid, int(time.time() * 1000) % 10_000_000, suffix))
            f.write_bytes(raw)
        except Exception:
            log("subtitle download failed", url, traceback.format_exc())
            return
        if gen != self.gen:
            return
        if stamp:
            self.sub_loaded[stamp[0]] = stamp[1]
        self.bus.sub_file.emit(str(f), "%s|%s|%s" % (title, lang, stamp[0] if stamp else ""), select)

    def on_sub_file(self, path, meta, select):
        if self.m is None:
            return
        title, lang, target = (meta.split("|") + ["", "", ""])[:3]
        try:
            self.m.command("sub-add", path, "select" if select else "auto", title, lang[:8] if lang else "")
        except Exception:
            log("sub-add failed", traceback.format_exc())

    def on_ai(self, msg):
        if msg.startswith("select:"):
            tgt = msg[7:]
            for t in (self.m.track_list if self.m else []) or []:
                if t.get("type") == "sub" and t.get("external") and ("(AI)" in str(t.get("title", "")) or tgt in str(t.get("title", ""))):
                    try:
                        self.m["sid"] = t["id"]
                    except Exception:
                        pass
                    return
        elif msg.startswith("say:"):
            self.toast.say(msg[4:], 3200)

    def watch_ai(self, gen):
        """While an AI job for this video runs: poll it and add the track as soon as (part of) it exists. Nothing is drawn on screen
        except a short toast when it is ready."""
        def work():
            seen_running = False
            while gen == self.gen and not self.closing:
                time.sleep(2.0)
                try:
                    d = self.api.get_json("/api/videos/%s/autosubs" % self.vid)
                except Exception:
                    continue
                jobs = [j for j in d.get("jobs") or [] if j.get("state") in ("queued", "running")]
                for t in d.get("tracks") or []:
                    if self.sub_loaded.get(t["target"]) != t.get("created"):
                        first = t["target"] not in self.sub_loaded
                        self.fetch_sub(t.get("url"), t.get("label") or "Subtitles (AI)", t.get("lang") or "", first and not self.any_sub(), gen,
                                       stamp=(t["target"], t.get("created")))
                        if first:
                            self.bus.ai.emit("say:AI subtitles are ready: " + str(t.get("label") or ""))
                if jobs:
                    seen_running = True
                    self.ai_job = "AI subtitles %s%%" % jobs[0].get("pct", 0)
                else:
                    self.ai_job = ""
                    return
        threading.Thread(target=work, daemon=True).start()

    def any_sub(self):
        try:
            return any(t.get("type") == "sub" and t.get("selected") for t in self.m.track_list)
        except Exception:
            return False

    def start_ai(self):
        pr = self.sess.get("prefs") or {}
        try:
            self.api.post_json("/api/videos/%s/autosubs" % self.vid, {"target": pr.get("asub_lang") or "en", "mode": pr.get("asub_mode") or "accurate"})
        except Exception as e:
            msg = "Could not start AI subtitles"
            try:
                import json as _j
                body = e.read().decode("utf-8") if hasattr(e, "read") else ""
                msg = _j.loads(body).get("error") or msg
            except Exception:
                pass
            self.toast.say(msg, 4500)
            return
        self.toast.say("AI subtitles started: they appear here when ready", 3500)
        self.watch_ai(self.gen)

    # ---- timeline preview
    def start_thumbs(self):
        if (self.sess.get("prefs") or {}).get("hover_preview") is False:
            return
        dur = 0.0
        try:
            dur = float(self.sess.get("duration") or 0)
        except (TypeError, ValueError):
            pass
        gen = self.gen

        def work():
            time.sleep(4.0)                                     # let playback settle before the server starts decoding frames
            d = dur
            for _ in range(40):
                d = d or float(self.st.get("dur") or 0)
                if d > 0 or gen != self.gen:
                    break
                time.sleep(0.5)
            if d <= 0:
                return
            chunks = max(2, min(5, int(round(d / 1800.0))))
            self.thumb_chunks = chunks
            for c in range(chunks):
                if gen != self.gen or self.closing:
                    return
                a, b = c * d / chunks, (c + 1) * d / chunks
                try:
                    raw = self.api.get_bytes("/api/videos/%s/strip?a=%.2f&b=%.2f&n=%d&w=176" % (self.vid, a, b, self.thumb_n), timeout=180)
                except Exception:
                    log("strip failed", traceback.format_exc())
                    continue
                self.bus.thumb.emit(gen, c, raw)
        threading.Thread(target=work, daemon=True).start()

    def on_thumb(self, gen, chunk, raw):
        if gen != self.gen:
            return
        img = QImage.fromData(raw)
        if img.isNull():
            return
        n = self.thumb_n
        fw = img.width() // n
        for k in range(n):
            self.thumbs[chunk * n + k] = QPixmap.fromImage(img.copy(k * fw, 0, fw, img.height()))

    def on_seek_hover(self, f, x):
        if f < 0 or not self.ui_on:
            self.preview.hide()
            return
        d = float(self.st.get("dur") or 0)
        if d <= 0:
            return
        t = f * d
        idx = max(0, min(self.thumb_n * self.thumb_chunks - 1, int(t / d * self.thumb_n * self.thumb_chunks)))
        pix = self.thumbs.get(idx)
        if (self.sess.get("prefs") or {}).get("hover_preview") is False:
            pix = None                                           # Settings: previews off, the time (and chapter) still show
        elif pix is None and self.thumbs:                          # nearest frame that exists
            near = min(self.thumbs, key=lambda i: abs(i - idx))
            pix = self.thumbs[near]
        chap = ""
        for ct, title in self.chapters:
            if ct <= t + 0.01:
                chap = title
        self.preview.set_content(pix, fmt_time(t), chap)
        p = self.seek.mapTo(self.stage, QPoint(x, 0))
        px = max(8, min(self.stage.width() - self.preview.width() - 8, p.x() - self.preview.width() // 2))
        self.preview.move(px, (self.trim.y() if self.trim.isVisible() else self.bar.y()) - self.preview.height() - 8)
        self.preview.show()
        self.preview.raise_()

    # ---- controls
    def toggle_pause(self):
        if self.m is None or self.hp.active():
            return
        try:
            if self.st.get("eof"):
                self.m.command("seek", 0, "absolute")
                self.m["pause"] = False
            else:
                self.m["pause"] = not bool(self.m["pause"])
        except Exception:
            log("pause failed", traceback.format_exc())

    def seek_abs(self, t, exact=True):
        if self.m is None:
            return
        try:
            self.m.command("seek", "%.3f" % max(0.0, t), "absolute+exact" if exact else "absolute+keyframes")
        except Exception:
            log("seek failed", traceback.format_exc())

    def seek_rel(self, d):
        if self.m is None:
            return
        try:
            self.m.command("seek", d, "relative+exact")
            self.toast.say(("+%d s" if d > 0 else "%d s") % d, 700)
        except Exception:
            log("seek failed", traceback.format_exc())

    def on_seek_bar(self, f, final):
        d = float(self.st.get("dur") or 0)
        if d > 0:
            self.seek_abs(f * d, final)
        if final:
            self.save_progress()

    def set_volume(self, v):
        if self.m is None:
            return
        try:
            self.m["volume"] = max(0.0, min(100.0, v * 100.0))
            self.m["mute"] = False
        except Exception:
            pass

    def add_volume(self, d):
        v = max(0.0, min(100.0, float(self.st.get("vol", 80)) + d))
        self.set_volume(v / 100.0)
        self.toast.say("Volume %d%%" % round(v), 800)

    def toggle_mute(self):
        if self.m is not None:
            try:
                self.m["mute"] = not bool(self.m["mute"])
            except Exception:
                pass

    def toggle_fullscreen(self):
        if self.mini:
            self.toggle_mini()
            return
        if self.isFullScreen():
            (self.showMaximized if self._was_max else self.showNormal)()
        else:
            self._was_max = self.isMaximized()
            self.showFullScreen()
        QTimer.singleShot(60, self.layout_overlay)

    def screenshot(self):
        if self.m is None:
            return
        d = Path(self.sess.get("shots_dir") or (Path.home() / "Pictures" / "ULTRON"))
        try:
            d.mkdir(parents=True, exist_ok=True)
            f = d / ("%s_%s.png" % (Path(self.sess.get("path", "video")).stem[:40], time.strftime("%Y%m%d_%H%M%S")))
            self.m.command("screenshot-to-file", str(f), "video")
            self.toast.say("Screenshot saved to %s" % (d.name or str(d)))
        except Exception:
            log("screenshot failed", traceback.format_exc())
            self.toast.say("Screenshot failed")

    # ---- menus
    def _menu(self, btn, build):
        m = QMenu(self)
        m.setStyleSheet(MENU_QSS)
        build(m)
        self.menu_open = True
        try:
            m.exec(btn.mapToGlobal(QPoint(0, 0)) - QPoint(0, m.sizeHint().height() + 8))
        finally:
            self.menu_open = False
            self.last_move = time.time()

    def tracks(self, kind):
        try:
            return [t for t in (self.m.track_list or []) if t.get("type") == kind]
        except Exception:
            return []

    def track_label(self, t, i):
        bits = []
        title, lg = str(t.get("title") or ""), lang_name(t.get("lang"))
        if lg and lg.lower() not in title.lower():
            bits.append(lg)
        if title:
            bits.append(title)
        if not bits:
            bits.append("Track %d" % (i + 1))
        if t.get("type") == "audio" and t.get("demux-channel-count"):
            bits.append("%dch" % t["demux-channel-count"])
        if t.get("codec"):
            bits.append(str(t["codec"]).upper())
        return " \u00b7 ".join(bits)

    def menu_audio(self):
        def build(m):
            tr = self.tracks("audio")
            if not tr:
                m.addAction("No audio tracks").setEnabled(False)
            for i, t in enumerate(tr):
                a = m.addAction(("\u2713  " if t.get("selected") else "     ") + self.track_label(t, i))
                a.triggered.connect(lambda _=False, tid=t["id"]: self._set_prop("aid", tid))
            try:
                devs = [d for d in (self.m.audio_device_list or []) if d.get("name")]
                cur = str(self.m["audio-device"] or "auto")
            except Exception:
                devs, cur = [], "auto"
            if devs:
                m.addSeparator()
                sub = m.addMenu("Output device")
                sub.setStyleSheet(MENU_QSS)
                for d in devs:
                    name = str(d["name"])
                    desc = str(d.get("description") or name)
                    if name == "auto":
                        desc = "Windows default"
                    a = sub.addAction(("\u2713  " if name == cur else "     ") + desc)
                    a.triggered.connect(lambda _=False, n=name, ds=desc: self.set_audio_device(n, ds))
        self._menu(self.b_audio, build)

    def set_audio_device(self, name, desc):
        """Switch the sound output now and remember it (Settings > Playback > audio device matches by name)."""
        self._set_prop("audio-device", name)
        self.toast.say("Sound: " + desc, 1600)
        keep = "" if name == "auto" else desc[:80]

        def work():
            try:
                self.api.post_json("/api/prefs", {"mpv_audio_device": keep})
            except Exception:
                log("could not save the audio device", traceback.format_exc())
        threading.Thread(target=work, daemon=True).start()

    # ---- A-B loop
    def set_ab(self, a, b):
        self.ab = [a, b]
        self.apply_ab()

    def apply_ab(self):
        """Push the A-B points to mpv. It loops only when both points exist and LOOP is on; otherwise they are just markers."""
        a, b = self.ab
        loop = a is not None and b is not None and self.ab_loop
        self._set_prop("ab-loop-a", a if loop else "no")
        self._set_prop("ab-loop-b", b if loop else "no")
        self.b_ab.accent = a is not None
        self.b_ab.update()

    def ab_cycle(self):
        if self.m is None:
            return
        t = float(self.st.get("t") or 0)
        a, b = self.ab
        if a is None:
            self.set_ab(t, None)
            self.toast.say("Loop start set: press B again for the end", 1800)
        elif b is None:
            if t <= a + 0.25:
                self.toast.say("Move further on, then set the end", 1400)
                return
            self.set_ab(a, t)
            self.toast.say("Looping %s \u2192 %s" % (fmt_time(a), fmt_time(t)) if self.ab_loop else "Part %s \u2192 %s marked" % (fmt_time(a), fmt_time(t)), 1800)
        else:
            self._range_stop = None
            self.set_ab(None, None)
            self.toast.say("Loop cleared", 1000)

    def toggle_ultron(self):
        on = not self.bar.ultron
        for w in (self.bar, self.trim):
            w.ultron = on
            w.update()
        self.seek.wave = on
        self.b_play.accent = on
        self.b_play.update()
        self.seek.update()
        self.toast.say("Ultron look on" if on else "Ultron look off", 1100)

    # ---- precision trimmer: filmstrip, IN / OUT (shared with the A-B loop), save clip
    def trim_vis(self):
        show = self.trim_open and self.ui_on and not self.mini
        if self.trim.isVisible() != show:
            self.trim.setVisible(show)
            if show:
                self.layout_overlay()
                self._strip_key = None
            self.lift_applied = None
        self.b_trim.accent = self.trim_open
        self.b_trim.update()

    def toggle_trim(self):
        if self.trim_open:
            self.close_trim()
            return
        if self.m is None or self.mini:
            return
        if self.sess.get("private"):
            self.toast.say("The trimmer is not available in the private library", 2200)
            return
        d = float(self.st.get("dur") or 0)
        if d <= 0:
            self.toast.say("Wait until the video has loaded", 1500)
            return
        s = self.trim.strip
        s.win = float(min(WINS, key=lambda w: abs(w - s.win)))
        if s.win > d:
            s.win = float(max(4, math.ceil(d)))
        s.ws = max(0.0, min(math.floor(float(self.st.get("t") or 0) / s.win) * s.win, max(0.0, d - 0.01)))
        for k in ("container-fps", "estimated-vf-fps"):
            try:
                v = float(self.m[k] or 0)
                if 1 < v < 241:
                    self._fps = v
                    break
            except Exception:
                pass
        self.trim_open = True
        self._strip_key = None
        self.set_ui(True)
        self.trim_vis()
        self.trim_refresh()

    def close_trim(self):
        self.trim_open = False
        self._range_stop = None
        self.trim_vis()

    def trim_fetch(self):
        s = self.trim.strip
        d = float(self.st.get("dur") or 0)
        a, b = max(0.0, s.ws), min(d, s.ws + s.win)
        if not b > a:
            return
        n = max(4, min(30, int(round(s.width() / 110.0))))
        key = (self.gen, round(a, 2), round(b, 2), n)
        if key == self._strip_key or time.time() < self._strip_fail:
            return
        self._strip_key = key
        gen, vid, api = self.gen, self.vid, self.api

        def work():
            try:
                raw = api.get_bytes("/api/videos/%s/strip?a=%.2f&b=%.2f&n=%d&w=180" % (vid, a, b, n), timeout=120)
            except Exception:
                log("trimmer strip failed", traceback.format_exc())
                self._strip_fail = time.time() + 6.0                 # do not hammer the server; try again in a few seconds
                if self._strip_key == key:
                    self._strip_key = None
                return
            self.bus.strip.emit(gen, a, b, raw)
        threading.Thread(target=work, daemon=True).start()

    def on_strip(self, gen, a, b, raw):
        if gen != self.gen or not self._strip_key or abs(self._strip_key[1] - a) > 0.02 or abs(self._strip_key[2] - b) > 0.02:
            return                                                    # another video, or the strip moved on since
        img = QImage.fromData(raw)
        if not img.isNull():
            self.trim.strip.set_pix(QPixmap.fromImage(img), a, b)

    def trim_refresh(self):
        """Called by the clock while the panel shows: keeps the window on the playhead and the labels current."""
        s = self.trim.strip
        d, t = float(self.st.get("dur") or 0), float(self.st.get("t") or 0)
        if d > 0 and not s.drag and not (s.ws <= t <= s.ws + s.win):
            s.ws = max(0.0, min(math.floor(t / s.win) * s.win, max(0.0, d - 0.01)))
            self._strip_key = None
        self.trim_fetch()
        self.trim.refresh(t, d, self.ab[0], self.ab[1], self._fps, self.ab_loop)

    def trim_zoom(self, direction, anchor=None, frac=0.5):
        s = self.trim.strip
        d = float(self.st.get("dur") or 0)
        i = min(range(len(WINS)), key=lambda k: abs(WINS[k] - s.win))
        nw = float(WINS[max(0, min(len(WINS) - 1, i + direction))])
        if d and nw > d:
            nw = float(max(4, math.ceil(d)))
        if nw == s.win:
            return
        at = anchor if anchor is not None else float(self.st.get("t") or 0)
        s.win = nw
        s.ws = max(0.0, min(at - frac * nw, max(0.0, (d or nw) - nw)))
        self._strip_key = None
        self.trim_refresh()

    def trim_jump(self, t):
        s = self.trim.strip
        d = float(self.st.get("dur") or 0)
        s.ws = max(0.0, min(math.floor(t / s.win) * s.win, max(0.0, d - 0.01)))
        self._strip_key = None
        self.seek_abs(t, False)

    def trim_handle(self, which, t, final):
        a, b = self.ab
        if which == "in":
            t = max(0.0, min(t, b - 0.04) if b is not None else t)
            self.ab = [t, b]
        else:
            a = a if a is not None else 0.0
            t = max(t, a + 0.04)
            self.ab = [a, t]
        self.seek_abs(t, final)
        if final:
            self.apply_ab()                                          # mpv only hears the new points when the drag ends

    def trim_set_in(self):
        t = float(self.st.get("t") or 0)
        a, b = self.ab
        self.set_ab(t, b if (b is not None and b > t + 0.04) else None)
        self.toast.say("IN  %s" % tc_frames(t, self._fps), 1100)

    def trim_set_out(self):
        t = float(self.st.get("t") or 0)
        a, b = self.ab
        a = a if a is not None else 0.0
        if a >= t - 0.04:
            self.toast.say("OUT has to come after IN", 1500)
            return
        self.set_ab(a, t)
        self.toast.say("OUT  %s" % tc_frames(t, self._fps), 1100)

    def trim_go(self, which):
        v = self.ab[which]
        if v is not None:
            self.seek_abs(v, True)

    def trim_range_play(self):
        a, b = self.ab
        if a is None or b is None:
            self.toast.say("Set IN and OUT first", 1400)
            return
        self._range_stop = None if self.ab_loop else b
        self.seek_abs(a, True)
        try:
            self.m["pause"] = False
        except Exception:
            log("range play failed", traceback.format_exc())

    def trim_loop_toggle(self):
        self.ab_loop = not self.ab_loop
        self.apply_ab()
        self.toast.say("Loop on" if self.ab_loop else "Stops at OUT", 1000)

    def trim_clear(self):
        self._range_stop = None
        self.set_ab(None, None)
        self.toast.say("IN / OUT cleared", 1000)

    def trim_step(self, kind, n):
        if self.m is None:
            return
        try:
            self.m["pause"] = True
            if kind == "s":
                self.m.command("seek", n, "relative+exact")
            elif abs(n) == 1:
                self.m.command("frame-step" if n > 0 else "frame-back-step")
            else:
                self.m.command("seek", n / max(1.0, self._fps), "relative+exact")
        except Exception:
            log("trim step failed", traceback.format_exc())

    def trim_save(self):
        a, b = self.ab
        if a is None or b is None:
            self.toast.say("Set IN and OUT first", 1400)
            return
        if self._saving:
            return
        self._saving = True
        self.trim.b_save.setEnabled(False)
        self.trim.b_save.setText("SAVING\u2026")
        vid, api, bus = self.vid, self.api, self.bus

        def work():
            try:
                r = api.post_json("/api/videos/%s/clip" % vid, {"a": a, "b": b}, timeout=900)
                msg = "Saved: Clips / %s" % (r.get("file") or "clip")
            except urllib.error.HTTPError as ex:
                try:
                    msg = json.loads(ex.read().decode("utf-8")).get("error") or "Could not save the clip"
                except Exception:
                    msg = "Could not save the clip"
            except Exception:
                log("clip failed", traceback.format_exc())
                msg = "Could not save the clip"
            bus.toast.emit(msg)
            bus.clip_done.emit()
        threading.Thread(target=work, daemon=True).start()

    def on_clip_done(self):
        self._saving = False
        self.trim.b_save.setEnabled(True)
        self.trim.b_save.setText("SAVE CLIP")

    def menu_subs(self):
        def build(m):
            on = False
            tr = self.tracks("sub")
            for i, t in enumerate(tr):
                on = on or bool(t.get("selected"))
            a = m.addAction(("\u2713  " if not on else "     ") + "Off")
            a.triggered.connect(lambda: self._set_prop("sid", "no"))
            for i, t in enumerate(tr):
                a = m.addAction(("\u2713  " if t.get("selected") else "     ") + self.track_label(t, i))
                a.triggered.connect(lambda _=False, tid=t["id"]: self._set_prop("sid", tid))
            m.addSeparator()
            m.addAction("     Add subtitle file\u2026").triggered.connect(self.add_sub_file)
            m.addAction("     Subtitles earlier  (Z)").triggered.connect(lambda: self.sub_delay(-0.1))
            m.addAction("     Subtitles later  (X)").triggered.connect(lambda: self.sub_delay(0.1))
            self.menu_sub_style(m)
            if (self.sess.get("prefs") or {}).get("asub_enabled", True) is not False:
                m.addSeparator()
                if self.ai_job:
                    m.addAction("     " + self.ai_job + " \u2026").setEnabled(False)
                else:
                    m.addAction("     Generate subtitles (AI)\u2026").triggered.connect(self.start_ai)
        self._menu(self.b_cc, build)

    def menu_speed(self):
        def build(m):
            cur = float(self.st.get("speed") or 1)
            for s in (0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 3.0):
                a = m.addAction(("\u2713  " if abs(s - cur) < 0.01 else "     ") + ("Normal" if s == 1.0 else "%gx" % s))
                a.triggered.connect(lambda _=False, v=s: self._set_prop("speed", v))
            self.menu_chapters(m)
        self._menu(self.b_speed, build)

    # ---- mini player (small, always on top; E or the button again to expand)
    def _topmost(self, on):
        if sys.platform != "win32":
            return
        try:
            u = ctypes.windll.user32
            u.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
            u.SetWindowPos(int(self.winId()), ctypes.c_void_p(-1 if on else -2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)
        except Exception:
            log("topmost failed", traceback.format_exc(limit=1))

    def _compact_buttons(self, compact):
        keep = (self.b_play, self.b_prev, self.b_next, self.lbl_time, self.b_cc, self.b_fs)
        for w in (self.b_back, self.b_fwd, self.b_vol, self.vol, self.b_audio, self.b_speed, self.b_ab, self.b_pic, self.b_lights,
                  self.b_sleep, self.b_shot, self.b_mini):
            w.setVisible(not compact)
        self.b_trim.setVisible(not compact and not self.sess.get("private"))
        if compact:
            self.close_trim()
        self.b_fs.setToolTip("Expand (E)" if compact else "Fullscreen (F)")

    def toggle_mini(self):
        if self.m is None:
            return
        if not self.mini:
            self._pre = (self.isFullScreen(), self.isMaximized(), self.normalGeometry(), self._was_max)
            self.mini = True
            if self.isFullScreen() or self.isMaximized():
                self.showNormal()
            w = 480
            vw, vh = self.st.get("w") or 16, self.st.get("h") or 9
            h = max(220, min(340, int(w * vh / max(1, vw))))
            ag = self.screen().availableGeometry()
            self.setGeometry(ag.right() - w - 20, ag.bottom() - h - 20, w, h)
            self._compact_buttons(True)
            self.top.setVisible(False)
            self._topmost(True)
            self.toast.say("Mini player: wheel seeks, E expands", 2200)
        else:
            self.mini = False
            fs, mx, g, was = self._pre or (False, True, None, True)
            self._topmost(False)
            self._compact_buttons(False)
            self.b_prev.setVisible(bool(self.sess.get("prev")))
            self.b_next.setVisible(bool(self.sess.get("next")))
            self.top.setVisible(self.ui_on)
            if g is not None and not (fs or mx):
                self.setGeometry(g)
            elif fs:
                self._was_max = was
                self.showFullScreen()
            else:
                self.showMaximized()
        QTimer.singleShot(80, self.layout_overlay)

    # ---- media keys (work even when another program has focus) + Windows media controls
    def register_media_keys(self):
        if sys.platform != "win32":
            return
        try:
            u = ctypes.windll.user32
            hwnd = int(self.winId())
            for i, vk in enumerate((0xB3, 0xB0, 0xB1, 0xB2)):          # play/pause, next, previous, stop
                if u.RegisterHotKey(hwnd, 0xA100 + i, 0x4000, vk):         # MOD_NOREPEAT
                    self._hotkeys.append(0xA100 + i)
        except Exception:
            log("media keys unavailable", traceback.format_exc(limit=1))

    def unregister_media_keys(self):
        try:
            u = ctypes.windll.user32
            for i in self._hotkeys:
                u.UnregisterHotKey(int(self.winId()), i)
        except Exception:
            pass
        self._hotkeys = []

    def nativeEvent(self, event_type, message):
        try:
            if bytes(event_type) == b"windows_generic_MSG" and self._hotkeys:
                import ctypes.wintypes as wt
                msg = wt.MSG.from_address(int(message))
                if msg.message == 0x0312 and msg.wParam in self._hotkeys:
                    self.on_media(("pause", "next", "prev", "stop")[msg.wParam - 0xA100])
                    return True, 0
        except Exception:
            pass
        return super().nativeEvent(event_type, message)

    def on_media(self, what):
        if self.closing or self.m is None or self.hp.active():
            return
        if what in ("play", "pause"):
            paused = bool(self.st.get("pause"))
            if (what == "play" and paused) or (what == "pause" and not paused):
                self.toggle_pause()
            self.toast.say("Paused" if what == "pause" else "Playing", 700)
        elif what == "next":
            if self.sess.get("next"):
                self.goto(self.sess.get("next"))
            else:
                self.toast.say("No next episode", 1000)
        elif what == "prev":
            if self.sess.get("prev"):
                self.goto(self.sess.get("prev"))
            else:
                self.seek_abs(0, True)
        elif what == "stop":
            try:
                self.m["pause"] = True
            except Exception:
                pass
            self.seek_abs(0, True)

    # ---- lights (the lightbulb): theater and night mode
    def cycle_lights(self):
        self.lights = (self.lights + 1) % 3
        self.bar.dim = self.lights > 0
        self.bar.update()
        self._set_prop("brightness", -12 if self.lights == 2 else 0)
        self.b_lights.accent = self.lights > 0
        self.b_lights.update()
        self.toast.say(("Lights on", "Theater: controls hide quickly", "Night: theater and a softer picture")[self.lights], 1500)

    # ---- keyboard hints
    def toggle_hints(self):
        if self.hints.isVisible():
            self.hints.hide()
        else:
            self.hints.show()
            self.hints.raise_()

    def first_run_hint(self):
        """Once ever: tell the user the cheat sheet exists, then remember that it was shown."""
        if self.hints_shown or self.hp.active() or (self.sess.get("prefs") or {}).get("native_hints") is False:
            return
        self.hints_shown = True
        self.toast.say("Tip: press ? any time for the keyboard shortcuts", 4500)

        def work():
            try:
                self.api.post_json("/api/prefs", {"native_hints": False})
            except Exception:
                log("could not save the hint flag", traceback.format_exc())
        threading.Thread(target=work, daemon=True).start()

    # ---- remembered window size and position
    def _state_file(self):
        d = str(self.sess.get("data_dir") or "")
        return Path(d) / "native_window.json" if d else None

    def load_window_state(self):
        f = self._state_file()
        if f is None or (self.sess.get("prefs") or {}).get("remember_size") is False or not f.exists():
            return None
        try:
            import json
            d = json.loads(f.read_text(encoding="utf-8"))
            r = QRectF(float(d["x"]), float(d["y"]), float(d["w"]), float(d["h"]))
            from PySide6.QtGui import QGuiApplication
            if r.width() < 480 or r.height() < 320:
                return None
            for scr in QGuiApplication.screens():                    # only if it still lands on a screen that exists
                inter = scr.availableGeometry().toRectF().intersected(r)
                if inter.width() > 160 and inter.height() > 120:
                    return {"rect": r.toRect(), "max": bool(d.get("max", True))}
        except Exception:
            log("window state unreadable", traceback.format_exc())
        return None

    def save_window_state(self):
        f = self._state_file()
        if self.mini or f is None or (self.sess.get("prefs") or {}).get("remember_size") is False:
            return
        try:
            import json
            g = self.normalGeometry()
            mx = self.isMaximized() or (self.isFullScreen() and self._was_max)
            if g.width() < 480 or g.height() < 320:
                return
            f.write_text(json.dumps({"x": g.x(), "y": g.y(), "w": g.width(), "h": g.height(), "max": mx}), encoding="utf-8")
        except Exception:
            log("could not save the window state", traceback.format_exc())

    # ---- chapters
    def load_chapters(self, d):
        try:
            raw = self.m["chapter-list"] or []
        except Exception:
            raw = []
        out = []
        for i, c in enumerate(raw):
            try:
                out.append((float(c.get("time") or 0), str(c.get("title") or "Chapter %d" % (i + 1))))
            except Exception:
                continue
        self.chapters = out if len(out) > 1 else []
        self.seek.chapters = [t / d for t, _ in self.chapters]
        self.seek.update()

    def step_chapter(self, n):
        if not self.chapters:
            self.seek_rel(60 * n)                                   # no chapters: jump a minute instead
            return
        try:
            self.m.command("add", "chapter", str(n))
            idx = int(self.m["chapter"] or 0)
            if 0 <= idx < len(self.chapters):
                self.toast.say(self.chapters[idx][1], 1300)
        except Exception:
            log("chapter step failed", traceback.format_exc())

    def menu_chapters(self, m):
        if not self.chapters:
            return
        m.addSeparator()
        sub = m.addMenu("Chapters")
        sub.setStyleSheet(MENU_QSS)
        t = float(self.st.get("t") or 0)
        cur = max([i for i, (ct, _) in enumerate(self.chapters) if ct <= t + 0.01] or [0])
        for i, (ct, title) in enumerate(self.chapters):
            a = sub.addAction(("\u2713  " if i == cur else "     ") + "%s   %s" % (fmt_time(ct), title))
            a.triggered.connect(lambda _=False, v=ct: self.seek_abs(v, True))

    # ---- subtitle appearance (colour, outline, position), remembered between videos
    SUB_COLORS = (("White", "#FFFFFF"), ("Yellow", "#FFE600"), ("Cyan", "#00E5FF"), ("Green", "#7CFF6B"), ("Pink", "#FF7AD9"))
    SUB_OUTLINES = (("None", 0), ("Thin", 1.5), ("Normal", 3), ("Thick", 5))
    SUB_POSITIONS = (("Bottom", 100), ("Low", 95), ("Raised", 88), ("High", 78))

    def apply_sub_style(self, pr):
        col = str(pr.get("subs_color") or "#FFFFFF")
        try:
            out = float(pr.get("subs_outline") if pr.get("subs_outline") is not None else 3)
            pos = int(pr.get("subs_pos") or 100)
        except (TypeError, ValueError):
            out, pos = 3.0, 100
        for k, v in (("sub-color", col), ("sub-border-color", "#000000"), ("sub-border-size", out),
                     ("sub-shadow-offset", 0 if out > 0 else 1), ("sub-back-color", "#00000000"), ("sub-pos", pos)):
            self._set_prop(k, v)

    def set_sub_style(self, key, value, label):
        pr = self.sess.setdefault("prefs", {})
        pr[key] = value
        self.apply_sub_style(pr)
        self.toast.say("Subtitles: " + label, 1100)

        def work():
            try:
                self.api.post_json("/api/prefs", {key: value})
            except Exception:
                log("could not save the subtitle style", traceback.format_exc())
        threading.Thread(target=work, daemon=True).start()

    def menu_sub_style(self, m):
        pr = self.sess.get("prefs") or {}
        tick = lambda on: "\u2713  " if on else "     "
        sub = m.addMenu("Appearance")
        sub.setStyleSheet(MENU_QSS)
        cur_c = str(pr.get("subs_color") or "#FFFFFF").upper()
        cur_o = float(pr.get("subs_outline") if pr.get("subs_outline") is not None else 3)
        cur_p = int(pr.get("subs_pos") or 100)
        cm = sub.addMenu("Colour")
        cm.setStyleSheet(MENU_QSS)
        for name, hexv in self.SUB_COLORS:
            cm.addAction(tick(cur_c == hexv) + name).triggered.connect(lambda _=False, h=hexv, n=name: self.set_sub_style("subs_color", h, n))
        om = sub.addMenu("Outline")
        om.setStyleSheet(MENU_QSS)
        for name, v in self.SUB_OUTLINES:
            om.addAction(tick(abs(cur_o - v) < 0.01) + name).triggered.connect(lambda _=False, x=v, n=name: self.set_sub_style("subs_outline", x, "outline " + n.lower()))
        pm = sub.addMenu("Position")
        pm.setStyleSheet(MENU_QSS)
        for name, v in self.SUB_POSITIONS:
            pm.addAction(tick(cur_p == v) + name).triggered.connect(lambda _=False, x=v, n=name: self.set_sub_style("subs_pos", x, "position " + n.lower()))
        sub.addAction("     Size: smaller  (G)").triggered.connect(lambda: self.sub_size(-10))
        sub.addAction("     Size: larger  (H)").triggered.connect(lambda: self.sub_size(10))

    def sub_size(self, d):
        try:
            cur = float(self.m["sub-scale"] or 1.0)
        except Exception:
            cur = 1.0
        v = max(0.3, min(3.0, cur + d / 100.0))
        self._set_prop("sub-scale", v)
        self.toast.say("Subtitle size %d%%" % round(v * 100), 900)

    # ---- rename + rating (same endpoints the library uses)
    def rename_title(self):
        from PySide6.QtWidgets import QInputDialog
        cur = self.lbl_title.text()
        dlg = QInputDialog(self)
        dlg.setStyleSheet("QDialog{background:#121216;}QLabel{color:#eee;font:10pt 'Segoe UI';}"
                          "QLineEdit{background:#1c1c22;color:#fff;border:1px solid #2c2c34;border-radius:8px;padding:6px 8px;font:11pt 'Segoe UI';}"
                          "QPushButton{background:#e11d2e;color:#fff;border:0;border-radius:8px;padding:6px 18px;font:700 9pt 'Segoe UI';}")
        dlg.setWindowTitle("Rename")
        dlg.setLabelText("Title (leave empty to go back to the file name):")
        dlg.setTextValue(cur)
        dlg.resize(520, 140)
        self.menu_open = True
        try:
            ok = dlg.exec()
        finally:
            self.menu_open = False
            self.last_move = time.time()
        if not ok:
            return
        vid = self.vid
        try:
            r = self.api.post_json("/api/videos/%s/title" % vid, {"title": dlg.textValue()})
        except Exception:
            log("rename failed", traceback.format_exc())
            self.toast.say("Could not rename")
            return
        if vid != self.vid:
            return
        t = r.get("title") or cur
        self.sess["title"] = t
        self.lbl_title.setText(t)
        self.setWindowTitle("%s \u2014 ULTRON" % t)
        self.toast.say("Renamed" if r.get("custom") else "Original name restored", 1200)

    def rate(self, n):
        self.stars.set_value(n)
        self.sess["user_rating"] = n
        vid = self.vid
        self.toast.say("Rating cleared" if n == 0 else "Rated %d of 5" % n, 1100)

        def work():
            try:
                self.api.post_json("/api/videos/%s/rating" % vid, {"stars": n})
            except Exception:
                log("rating failed", traceback.format_exc())
                self.bus.toast.emit("Could not save the rating")
        threading.Thread(target=work, daemon=True).start()

    # ---- sleep timer: fades the sound out over the last 10 s, then pauses (the player stays open)
    SLEEP_FADE = 10.0

    def menu_sleep(self):
        def build(m):
            active = self.sleep_at is not None or self.sleep_eov
            a = m.addAction(("\u2713  " if not active else "     ") + "Off")
            a.triggered.connect(lambda _=False: self.set_sleep(None))
            m.addSeparator()
            for mins in (15, 30, 45, 60, 90):
                on = self.sleep_at is not None and not self.sleep_eov and getattr(self, "_sleep_mins", 0) == mins
                a = m.addAction(("\u2713  " if on else "     ") + "%d minutes" % mins)
                a.triggered.connect(lambda _=False, v=mins: self.set_sleep(v))
            a = m.addAction(("\u2713  " if self.sleep_eov else "     ") + "End of this video")
            a.triggered.connect(lambda _=False: self.set_sleep("eov"))
        self._menu(self.b_sleep, build)

    def set_sleep(self, what):
        self.clear_fade()
        self.sleep_at, self.sleep_eov, self._sleep_mins = None, False, 0
        if what == "eov":
            self.sleep_eov = True
            self.toast.say("Sleep timer: stops after this video", 1600)
        elif what:
            self._sleep_mins = int(what)
            self.sleep_at = time.time() + 60.0 * int(what)
            self.toast.say("Sleep timer: %d minutes" % int(what), 1600)
        else:
            self.toast.say("Sleep timer off", 1100)
        self.b_sleep.accent = bool(self.sleep_at or self.sleep_eov)
        self.b_sleep.setToolTip("Sleep timer" if not self.b_sleep.accent else "Sleep timer: on")
        self.b_sleep.update()

    def clear_fade(self):
        if self.sleep_base is not None:
            self._set_prop("volume", self.sleep_base)      # a fade was running: give the volume back
            self.sleep_base = None

    def sleep_tick(self, now):
        if self.sleep_at is None:
            return
        left = self.sleep_at - now
        self.b_sleep.setToolTip("Sleep timer: %s left" % fmt_time(max(0.0, left)))
        if left > self.SLEEP_FADE:
            return
        if self.sleep_base is None:
            self.sleep_base = float(self.st.get("vol", 80))
        if left > 0:
            self._set_prop("volume", self.sleep_base * left / self.SLEEP_FADE)
            return
        try:
            self.m["pause"] = True
        except Exception:
            log("sleep pause failed", traceback.format_exc())
        self.clear_fade()
        self.sleep_at = None
        self.b_sleep.accent = False
        self.b_sleep.setToolTip("Sleep timer")
        self.b_sleep.update()
        self.set_ui(True)
        self.toast.say("Sleep timer: paused. Good night", 4000)

    # ---- picture: fit / fill, aspect ratio, zoom, pan
    def reset_picture(self, fit="fit", quiet=False):
        self.fit, self.zoom, self.pan, self.aspect = ("fill" if fit == "fill" else "fit"), 0.0, [0.0, 0.0], "-1"
        for k, v in (("panscan", 1.0 if self.fit == "fill" else 0.0), ("video-zoom", 0.0), ("video-pan-x", 0.0),
                     ("video-pan-y", 0.0), ("video-aspect-override", "-1")):
            self._set_prop(k, v)
        if not quiet:
            self.toast.say("Picture reset", 900)

    def set_fit(self, mode):
        self.fit = mode
        self._set_prop("panscan", 1.0 if mode == "fill" else 0.0)
        self.toast.say("Fill: cropped to the window" if mode == "fill" else "Fit: whole picture", 1100)

    def toggle_fit(self):
        self.set_fit("fit" if self.fit == "fill" else "fill")

    def set_aspect(self, val, label):
        self.aspect = val
        self._set_prop("video-aspect-override", val)
        self.toast.say("Aspect: " + label, 1100)

    def zoom_by(self, d):
        self.zoom = max(0.0, min(3.0, self.zoom + d))
        self._set_prop("video-zoom", self.zoom)
        if self.zoom <= 0.001:
            self.pan = [0.0, 0.0]
            self._set_prop("video-pan-x", 0.0)
            self._set_prop("video-pan-y", 0.0)
        self.toast.say("Zoom %d%%" % round(100 * 2 ** self.zoom), 800)

    def pan_by(self, dx, dy):
        w, h = max(1, self.stage.width()), max(1, self.stage.height())
        k = 2 ** self.zoom
        lim = max(0.0, 0.5 * (k - 1) / k) if k > 1 else 0.0         # do not drag the picture off the screen
        self.pan[0] = max(-lim, min(lim, self.pan[0] + dx / (w * k)))
        self.pan[1] = max(-lim, min(lim, self.pan[1] + dy / (h * k)))
        self._set_prop("video-pan-x", self.pan[0])
        self._set_prop("video-pan-y", self.pan[1])

    def menu_picture(self):
        def build(m):
            tick = lambda on: "\u2713  " if on else "     "
            for mode, label in (("fit", "Fit (whole picture)"), ("fill", "Fill (crop to window)")):
                a = m.addAction(tick(self.fit == mode) + label)
                a.triggered.connect(lambda _=False, v=mode: self.set_fit(v))
            m.addSeparator()
            sub = m.addMenu("Aspect ratio")
            sub.setStyleSheet(MENU_QSS)
            for val, label in (("-1", "Original"), ("16:9", "16:9"), ("4:3", "4:3"), ("21:9", "21:9"), ("2.39:1", "2.39:1"),
                               ("1.85:1", "1.85:1"), ("1:1", "1:1")):
                a = sub.addAction(tick(self.aspect == val) + label)
                a.triggered.connect(lambda _=False, v=val, l=label: self.set_aspect(v, l))
            m.addSeparator()
            for label, d in (("Zoom in  (+)", 0.25), ("Zoom out  (-)", -0.25)):
                a = m.addAction("     " + label)
                a.triggered.connect(lambda _=False, v=d: self.zoom_by(v))
            a = m.addAction("     Reset picture  (0)")
            a.triggered.connect(lambda _=False: self.reset_picture(self.sess.get("prefs", {}).get("default_fit") or "fit"))
        self._menu(self.b_pic, build)

    def _set_prop(self, k, v):
        try:
            self.m[k] = v
        except Exception:
            log("set %s failed" % k, traceback.format_exc())

    def sub_delay(self, d):
        try:
            self.m["sub-delay"] = round(float(self.m["sub-delay"]) + d, 2)
            self.toast.say("Subtitle delay %+.1f s" % float(self.m["sub-delay"]), 900)
        except Exception:
            pass

    def add_sub_file(self):
        self.menu_open = True
        f, _ = QFileDialog.getOpenFileName(self, "Add subtitle file", str(Path(self.sess.get("path", ".")).parent),
                                           "Subtitles (*.srt *.vtt *.ass *.ssa *.sub);;All files (*)")
        self.menu_open = False
        if f:
            try:
                self.m.command("sub-add", f, "select")
            except Exception:
                log("sub-add failed", traceback.format_exc())

    def cycle_subs(self):
        tr = self.tracks("sub")
        if not tr:
            self.toast.say("No subtitles")
            return
        ids = [t["id"] for t in tr]
        cur = next((t["id"] for t in tr if t.get("selected")), None)
        if cur is None:
            nxt = ids[0]
        elif cur == ids[-1]:
            nxt = "no"
        else:
            nxt = ids[ids.index(cur) + 1]
        self._set_prop("sid", nxt)
        self.toast.say("Subtitles off" if nxt == "no" else "Subtitles: " + self.track_label(next(t for t in tr if t["id"] == nxt), 0), 1100)

    # ---- episodes / progress
    def upnext_go(self):
        self.goto(self.sess.get("next"))

    def goto(self, vid):
        if not vid:
            return
        self.upnext.stop()
        self.save_progress()
        gen = self.gen

        def work():
            try:
                sess = self.api.get_json("/api/native/session/%s" % vid)
            except Exception:
                log("session failed", traceback.format_exc())
                self.bus.toast.emit("Could not open the next video")
                return
            if gen == self.gen:
                self.bus.session.emit(sess)
        threading.Thread(target=work, daemon=True).start()

    def save_progress(self, sync=False):
        d, t = float(self.st.get("dur") or 0), float(self.st.get("t") or 0)
        if d <= 0 or not self.st.get("loaded"):
            return
        vid, api = self.vid, self.api
        if self.st.get("eof") or t > d - 1.0:
            t = d

        def post():
            try:
                api.post_json("/api/videos/%s/progress" % vid, {"position": t, "duration": d}, timeout=4)
            except Exception:
                log("progress save failed", traceback.format_exc())
        if sync:
            post()
        else:
            threading.Thread(target=post, daemon=True).start()

    def count_view(self):
        if self.counted or self.resumed:
            self.counted = True
            return
        self.counted = True
        vid, api = self.vid, self.api

        def post():
            try:
                api.post_json("/api/videos/%s/view" % vid, {})
            except Exception:
                log("view count failed", traceback.format_exc())
        threading.Thread(target=post, daemon=True).start()

    # ---- the clock
    def tick(self):
        if self.m is None or self.closing:
            return
        st = self.st
        d, t = float(st.get("dur") or 0), float(st.get("t") or 0)
        paused = bool(st.get("pause"))
        self.b_play.set_icon("play" if paused or st.get("eof") else "pause")
        if self._media_last != (paused or bool(st.get("eof"))):
            self._media_last = paused or bool(st.get("eof"))
            self.winmedia.playing(not self._media_last)
        if not self.seek.dragging:
            self.seek.set_state(t / d if d > 0 else 0.0, float(st.get("cache") or 0) / d if d > 0 else 0.0)
        self.lbl_time.setText("%s / %s" % (fmt_time(t), fmt_time(d)))
        self.vol.set_value(float(st.get("vol", 80)) / 100.0, bool(st.get("mute")))
        self.b_vol.set_icon("mute" if st.get("mute") or float(st.get("vol", 80)) <= 0 else "vol")
        sp = float(st.get("speed") or 1)
        self.b_speed.label = ("%gx" % sp) if abs(sp - 1) > 0.01 else "1x"
        self.b_speed.accent = abs(sp - 1) > 0.01
        self.b_speed.update()
        self.b_fs.set_icon("unfs" if self.isFullScreen() else "fs")
        if st.get("w") and st.get("h"):
            from math import gcd
            g = gcd(st["w"], st["h"]) or 1
            ar = "%d:%d" % (st["w"] // g, st["h"] // g) if st["w"] // g < 40 else "%.2f:1" % (st["w"] / st["h"])
            self.lbl_info.setText("%s \u00b7 %d\u00d7%d \u00b7 %s" % (ar, st["w"], st["h"], str(st.get("fmt") or "").upper()))
        if not paused and st.get("loaded") and (t > 8 or (d and t > d * 0.02)):
            self.count_view()
        now = time.time()
        if not paused and now - self.last_save > 5.0:
            self.last_save = now
            self.save_progress()
        if not paused and not st.get("eof") and st.get("loaded") and self.sess.get("private") and now - self._beat_at > 10.0:
            self._beat_at = now                              # tell the app a private video is playing here, so the auto-lock waits
            api = self.api

            def beat():
                try:
                    api.post_json("/api/native/heartbeat", {}, timeout=4)
                except Exception:
                    log("heartbeat failed", traceback.format_exc())
            threading.Thread(target=beat, daemon=True).start()
        if self._remote_on and now - self._remote_at > 1.0:
            self._remote_at = now
            self._remote_report(st, t, d, paused)
        if st.get("eof") and not getattr(self, "_eof_done", False):
            self._eof_done = True
            self.save_progress()
            if self.sleep_eov:
                self.sleep_eov = False
                self.b_sleep.accent = False
                self.b_sleep.update()
                self.set_ui(True)
                self.toast.say("Sleep timer: stopped after this video", 4000)
            elif self.sess.get("next"):
                self.set_ui(True)
                self.upnext.start(self.sess.get("next_title") or "Next episode", "", (self.sess.get("prefs") or {}).get("next_countdown") or 8)
                self.layout_overlay()
        elif not st.get("eof"):
            self._eof_done = False
            if self.upnext.active():
                self.upnext.stop()
        if st.get("loaded") and self._chap_gen != self.gen and d > 0:
            self._chap_gen = self.gen
            self.load_chapters(d)
        if st.get("loaded") and self._card_gen != self.gen:
            self._card_gen = self.gen
            QTimer.singleShot(4800, self.first_run_hint)
            if float(self.sess.get("resume") or 0) < 30:                 # not when you jump back into the middle of a film
                sub = ("%s \u00b7 Episode %s" % (self.sess["series"], self.sess["index"])) if self.sess.get("series") else ""
                self.tcard.show_card(self.lbl_title.text(), sub)
        self.seek.playing = (not paused) and bool(st.get("loaded")) and not st.get("eof")
        a, b = self.ab
        self.seek.loop = (a / d if (a is not None and d > 0) else None, b / d if (b is not None and d > 0) else None)
        if self.b_ab.accent != (a is not None):
            self.b_ab.accent = a is not None
            self.b_ab.update()
        rs = self._range_stop
        if rs is not None and not paused and t >= rs - 0.03:
            self._range_stop = None
            try:
                self.m["pause"] = True
                self.seek_abs(rs, True)
            except Exception:
                log("stop at OUT failed", traceback.format_exc())
        if self.trim.isVisible():
            self.trim_refresh()
        self.sleep_tick(now)
        idle = now - self.last_move
        if self.ui_on and not paused and not self.menu_open and not self.seek.dragging and not self.trim_open and idle > (1.2 if self.lights else 2.8):
            self.set_ui(False)
        if self.ui_on:
            self.apply_lift()

    # ---- keys + close
    def keyPressEvent(self, e):
        k, mods = e.key(), e.modifiers()
        self.last_move = time.time()
        self.set_ui(True)
        if self.hp.active():                                  # the headphones prompt: only Esc (leave) and F (fullscreen) work until it is answered
            if k == Qt.Key_Escape:
                self.toggle_fullscreen() if self.isFullScreen() else self.close()
            elif k in (Qt.Key_F, Qt.Key_F11):
                self.toggle_fullscreen()
            return
        if self.hints.isVisible():
            self.hints.hide()
            if k in (Qt.Key_Question, Qt.Key_F1, Qt.Key_Escape):
                return
        if k in (Qt.Key_Space, Qt.Key_K):
            self.toggle_pause()
        elif k == Qt.Key_Left:
            self.seek_rel(-5)
        elif k == Qt.Key_Right:
            self.seek_rel(5)
        elif k == Qt.Key_J:
            self.seek_rel(-10)
        elif k == Qt.Key_L:
            self.seek_rel(10)
        elif k == Qt.Key_Up:
            self.add_volume(4)
        elif k == Qt.Key_Down:
            self.add_volume(-4)
        elif k == Qt.Key_M:
            self.toggle_mute()
        elif k in (Qt.Key_F, Qt.Key_F11):
            self.toggle_fullscreen()
        elif k == Qt.Key_Escape and self.trim_open:
            self.close_trim()
        elif k == Qt.Key_Escape and self.mini:
            self.toggle_mini()
        elif k == Qt.Key_Escape and self.upnext.active():
            self.upnext._cancel()
        elif k == Qt.Key_Escape:
            self.toggle_fullscreen() if self.isFullScreen() else self.close()
        elif k == Qt.Key_N:
            self.goto(self.sess.get("next"))
        elif k == Qt.Key_P:
            self.goto(self.sess.get("prev"))
        elif k == Qt.Key_PageUp:
            self.step_chapter(-1)
        elif k == Qt.Key_PageDown:
            self.step_chapter(1)
        elif k == Qt.Key_G:
            self.sub_size(-10)
        elif k == Qt.Key_H:
            self.sub_size(10)
        elif k == Qt.Key_E:
            self.toggle_mini()
        elif k == Qt.Key_MediaTogglePlayPause:
            self.on_media("pause" if not self.st.get("pause") else "play")
        elif k == Qt.Key_MediaNext:
            self.on_media("next")
        elif k == Qt.Key_MediaPrevious:
            self.on_media("prev")
        elif k == Qt.Key_MediaStop:
            self.on_media("stop")
        elif k in (Qt.Key_Question, Qt.Key_F1) or (k == Qt.Key_Slash and mods & Qt.ShiftModifier):
            self.toggle_hints()
        elif k == Qt.Key_D:
            self.cycle_lights()
        elif k == Qt.Key_F2:
            self.rename_title()
        elif k == Qt.Key_A:
            self.toggle_fit()
        elif k == Qt.Key_B:
            self.ab_cycle()
        elif k == Qt.Key_T:
            self.toggle_trim()
        elif k == Qt.Key_U:
            self.toggle_ultron()
        elif k == Qt.Key_I and self.trim_open:
            self.trim_set_in()
        elif k == Qt.Key_O and self.trim_open:
            self.trim_set_out()
        elif k == Qt.Key_Backslash and self.trim_open:
            self.trim_clear()
        elif k in (Qt.Key_Plus, Qt.Key_Equal):
            self.zoom_by(0.25)
        elif k == Qt.Key_Minus:
            self.zoom_by(-0.25)
        elif k == Qt.Key_0:
            self.reset_picture(self.sess.get("prefs", {}).get("default_fit") or "fit")
        elif k == Qt.Key_S:
            self.screenshot()
        elif k == Qt.Key_C:
            self.cycle_subs()
        elif k == Qt.Key_Z:
            self.sub_delay(-0.1)
        elif k == Qt.Key_X:
            self.sub_delay(0.1)
        elif k in (Qt.Key_Comma, Qt.Key_Period) and (self.st.get("pause") or self.trim_open):
            self.m.command("frame-back-step" if k == Qt.Key_Comma else "frame-step")
        elif k == Qt.Key_Home:
            self.seek_abs(0)
        elif k in (Qt.Key_Greater, Qt.Key_Less) or (k in (Qt.Key_BracketRight, Qt.Key_BracketLeft)):
            sp = float(self.st.get("speed") or 1) + (0.25 if k in (Qt.Key_Greater, Qt.Key_BracketRight) else -0.25)
            self._set_prop("speed", max(0.25, min(4.0, sp)))
            self.toast.say("Speed %gx" % max(0.25, min(4.0, sp)), 800)
        else:
            super().keyPressEvent(e)

    # ---- phone remote (see remote.py): commands arrive on a background thread and are handed to the UI thread
    def _remote_loop(self):
        api = self.api
        while not self.closing:
            try:
                d = api.get_json("/api/remote/poll?src=native", timeout=30)
            except Exception:
                time.sleep(5)
                continue
            self._remote_on = bool(d.get("on"))
            if not self._remote_on:
                time.sleep(15)
                continue
            for c in d.get("cmds") or []:
                if self.closing:
                    return
                self.bus.remote.emit(str(c.get("cmd") or ""), c.get("arg"))

    def _remote_report(self, st, t, d, paused):
        sess, api = self.sess or {}, self.api
        priv = bool(sess.get("private"))
        body = {"src": "native", "kind": "video", "private": priv,
                "title": "" if priv else (sess.get("title") or Path(sess.get("path", "")).stem),
                "sub": "" if priv or not sess.get("series") else "%s · Episode %s of %s" % (sess["series"], sess["index"], sess["total"]),
                "pos": t, "dur": d, "paused": bool(paused or st.get("eof")), "vol": float(st.get("vol", 80)) / 100.0,
                "muted": bool(st.get("mute")), "has_next": bool(sess.get("next")), "has_prev": bool(sess.get("prev"))}

        def send():
            try:
                api.post_json("/api/remote/status", body, timeout=4)
            except Exception:
                pass
        threading.Thread(target=send, daemon=True).start()

    def on_remote(self, cmd, arg):
        if self.closing or self.m is None:
            return
        try:
            if cmd == "toggle":
                if not self.hp.active():
                    self.toggle_pause()
            elif cmd == "seek_rel":
                self.seek_rel(int(float(arg or 0)))
            elif cmd == "seek_abs":
                self.seek_abs(float(arg or 0), True)
                self.save_progress()
            elif cmd == "vol":
                self.set_volume(float(arg or 0))
                self.toast.say("Volume %d%%" % round(float(arg or 0) * 100), 800)
            elif cmd == "mute":
                self.toggle_mute()
            elif cmd in ("next", "prev"):
                self.on_media(cmd)
            elif cmd == "close":
                self.close()
            self._remote_at = 0.0                          # report the new state right away
        except Exception:
            log("remote command failed", cmd, traceback.format_exc())

    def on_fail(self, why):
        log("giving up:", why)
        self.closing = True
        QApplication.exit(EXIT_FAIL)

    def closeEvent(self, e):
        if not self.closing:
            self.closing = True
            self.tick_t.stop()
            self.gen += 1
            self.save_window_state()
            self.unregister_media_keys()
            self.winmedia.close()
            try:
                self.save_progress(sync=True)
            except Exception:
                pass
        try:
            if self.stage.rctx is not None:
                self.stage.makeCurrent()
                self.stage.rctx.free()
                self.stage.rctx = None
                self.stage.doneCurrent()
        except Exception:
            log("render context free failed", traceback.format_exc())
        if self.m is not None:
            m, self.m = self.m, None
            t = threading.Thread(target=lambda: m.terminate(), daemon=True)
            t.start()
            t.join(2.5)
        e.accept()
        QApplication.quit()


def main(args, api):
    dirs = [d for d in str(args.mpvdir or "").split(";") if d.strip()]
    mod, lib, err = mpv_backend.load_module(dirs)
    if not mod:
        log("libmpv missing:", err)
        return EXIT_FAIL
    try:
        sess = api.get_json("/api/native/session/%s" % args.vid)
    except Exception:
        log("could not read the session:\n" + traceback.format_exc())
        return EXIT_FAIL
    fmt = QSurfaceFormat()
    fmt.setVersion(3, 3)
    fmt.setProfile(QSurfaceFormat.CoreProfile)
    fmt.setSwapInterval(1)
    QSurfaceFormat.setDefaultFormat(fmt)
    app = QApplication(sys.argv[:1])
    app.setApplicationName("ULTRON")
    win = Player(args, api, mod, sess)
    if os.environ.get("ULTRON_SELFTEST"):
        win.resize(1280, 720)
        win.show()
    elif str(args.fullscreen) == "1":
        win.showFullScreen()
    else:
        st = win.load_window_state()
        if st:
            win.setGeometry(st["rect"])
            win.showMaximized() if st["max"] else win.show()
        else:
            win.showMaximized()
    win.dark_titlebar()
    win.register_media_keys()
    shot = os.environ.get("ULTRON_SELFTEST")
    if shot and os.environ.get("ULTRON_SELFTEST_KEEPUI"):
        win.last_move = time.time() + 1e6                       # developer self-test: keep the controls on screen
    if shot:                                                    # developer self-test: draw a few seconds, save a picture, quit
        def snap():
            log("selftest state: ui_on=%s lift=%s pause=%s t=%.1f" % (win.ui_on, win.lift_applied, win.st.get("pause"), win.st.get("t", 0)))
            win.last_move = time.time() + 30
            win.set_ui(True)
            win.on_seek_hover(0.4, int(win.seek.width() * 0.4))
            if os.environ.get("ULTRON_SELFTEST_KEEPUI"):
                QTimer.singleShot(6000, win.close)
                return
            QTimer.singleShot(700, lambda: (win.grab().save(shot), win.close()))
            return
            win.close()
        QTimer.singleShot(int(os.environ.get("ULTRON_SELFTEST_MS", "5000")), snap)
    code = app.exec()
    log("closed with code", code)
    return EXIT_OK if code in (0, None) else int(code)
