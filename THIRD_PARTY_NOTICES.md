# Third-party notices

mail-server is released under the [MIT License](LICENSE). The web app in `public/` is built on a third-party template and bundles several open-source libraries. Their copyright notices and licenses are listed here and kept next to the files themselves.

## SmartMail (interface template)

The mailbox interface (markup, layout and the compiled stylesheet in `public/assets/css/style.min.css`) is based on [SmartMail](https://github.com/themepixels/smartmail) by ThemePixels, released under the MIT License. The colours are overridden with the Catppuccin Mocha palette, and the behaviour is rewritten to work with this project's API. The original license is also kept at `public/vendor/SMARTMAIL-LICENSE.txt`.

```
MIT License

Copyright (c) 2021 Mienard Lumaad

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Bundled libraries

| Component | License | Where |
|---|---|---|
| Bootstrap (CSS 5.0.2 inside the SmartMail stylesheet, JS 5.3.8) | MIT, © The Bootstrap Authors | `public/assets/css/style.min.css`, `public/lib/bootstrap/` |
| jQuery 3.7.1 | MIT, © OpenJS Foundation and other contributors | `public/lib/jquery/` |
| perfect-scrollbar 1.5.6 | MIT, © Hyunje Jun, MDBootstrap and contributors | `public/lib/perfect-scrollbar/` |
| Remix Icon 2.5.0 | Apache License 2.0, © RemixIcon.com | `public/lib/remixicon/` |
| DOMPurify 3.4.17 | Apache License 2.0 or Mozilla Public License 2.0, © Cure53 and other contributors | `public/vendor/purify.min.js` |
| jsPDF 4.2.1 | MIT, © James Hall and yWorks GmbH (license: `public/vendor/JSPDF-LICENSE.txt`) | `public/vendor/jspdf.umd.min.js` |
| html2canvas 1.4.1 | MIT, © Niklas von Hertzen (license: `public/vendor/HTML2CANVAS-LICENSE.txt`) | `public/vendor/html2canvas.min.js` |
| Lexend font | SIL Open Font License 1.1 (license: `public/assets/fonts/LEXEND-OFL-LICENSE.txt`) | `public/assets/fonts/` |
| Catppuccin Mocha palette | MIT, © Catppuccin | colour values in `public/assets/css/app.css` |

The minified files keep their own license headers. Node.js dependencies installed with `npm install` are covered by the licenses in their own packages.
