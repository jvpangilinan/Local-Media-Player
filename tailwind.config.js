/** Rebuild vendor/tailwind.css after editing index.html:
 *    npx tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.input.css -o vendor/tailwind.css --minify
 */
module.exports = {
  content: ['./index.html', './templates/index.html'],
  theme: {
    extend: {
      colors: {
        accent: '#ececee',
        lm: { base: '#0b0b0c', card: '#2b2b2b', text: '#e5e5e5' }
      },
      fontFamily: { sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'] }
    }
  },
  plugins: []
};
