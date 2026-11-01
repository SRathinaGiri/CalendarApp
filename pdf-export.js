/* ==========================================================================
   pdf-export.js — turns a printable HTML page (reports, monthly calendar)
   into an A4 PDF, then shares or saves it.

   - Works offline: jsPDF and html2canvas are bundled in vendor/pdfgen and are
     only loaded the first time a PDF is made.
   - Pages break between table rows, headings and paragraphs; elements with
     class "page-break" (or CSS break-before: page) start a new page.
   - Android app: Share opens the Android share sheet (WhatsApp, Gmail, Drive,
     Print...). Save writes to Documents › SRGCalendar › Reports.
   - Browser: Share uses the Web Share API where available; otherwise the PDF
     is downloaded.
   Pages are images of the rendered report, so text in the PDF can't be
   selected or searched.
   ========================================================================== */
(function (root) {
  'use strict';

  const A4 = { w: 595.28, h: 841.89 };              // points
  const MARGIN = { portrait: 28, landscape: 22 };    // points
  const PX_TO_PT = 0.75;                             // 96 dpi CSS px -> 72 dpi points (true print size)
  const SCALE = 2;                                   // render resolution
  const MAX_CHUNK_PX = 7000;                         // CSS px per html2canvas pass (canvas height limits)
  const REPORTS_DIR = 'SRGCalendar/Reports';

  let libsPromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function loadLibs() {
    if (!libsPromise) {
      libsPromise = Promise.all([
        root.html2canvas ? null : loadScript('vendor/pdfgen/html2canvas.min.js'),
        root.jspdf ? null : loadScript('vendor/pdfgen/jspdf.umd.min.js'),
      ]).catch((e) => { libsPromise = null; throw e; });
    }
    return libsPromise;
  }

  function geometry(orientation) {
    const land = orientation === 'landscape';
    const pageW = land ? A4.h : A4.w;
    const pageH = land ? A4.w : A4.h;
    const m = land ? MARGIN.landscape : MARGIN.portrait;
    const footer = 14;
    const contentWpt = pageW - 2 * m;
    const contentHpt = pageH - 2 * m - footer;
    return {
      land, pageW, pageH, m, footer,
      cssW: Math.round(contentWpt / PX_TO_PT),
      cssH: Math.floor(contentHpt / PX_TO_PT),
      ptPerPx: PX_TO_PT,
    };
  }

  /* ---------- render the HTML in a hidden, same-origin frame ---------- */

  function mountFrame(html, cssW) {
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${cssW}px;height:200px;border:0;opacity:0;pointer-events:none;z-index:-1;`;
      const extra = '<style>@page{margin:0}html,body{margin:0!important;background:#fff!important;}' +
        'body{width:' + cssW + 'px;box-sizing:border-box!important;}button,.no-print{display:none!important;}' +
        'img{max-width:100%!important;height:auto!important;}</style>';
      const doc = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, extra + '</head>') : extra + html;
      const timer = setTimeout(() => reject(new Error('The report took too long to lay out.')), 20000);
      frame.onload = () => {
        clearTimeout(timer);
        const d = frame.contentDocument;
        const imgs = Array.from(d.images || []);
        Promise.all(imgs.map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; }))))
          .then(() => (d.fonts && d.fonts.ready ? d.fonts.ready : null))
          .then(() => {
            const h = Math.max(d.documentElement.scrollHeight, d.body.scrollHeight);
            frame.style.height = h + 'px';
            requestAnimationFrame(() => resolve(frame));
          });
      };
      frame.srcdoc = doc;
      document.body.appendChild(frame);
    });
  }

  /* ---------- page breaks ---------- */

  // Cuts the content into pages of at most `pageH` CSS px, never through a row,
  // heading, paragraph, image or any other element shorter than half a page.
  function planPages(doc, pageH) {
    const body = doc.body;
    const total = Math.ceil(Math.max(doc.documentElement.scrollHeight, body.scrollHeight));
    const base = body.getBoundingClientRect().top;
    const view = doc.defaultView;
    const solid = [];   // [top, bottom] of elements that must not be cut
    const forced = [];  // tops of forced page breaks
    for (const el of body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0 || r.width <= 0) continue;
      const top = r.top - base;
      const bottom = r.bottom - base;
      const cs = view.getComputedStyle(el);
      if (el.classList.contains('page-break') || /page|always/.test(cs.breakBefore || '') || cs.pageBreakBefore === 'always') {
        if (top > 1) forced.push(top);
      }
      if (cs.display.startsWith('inline') && el.tagName !== 'IMG') continue;
      if (bottom - top < pageH * 0.5) solid.push([top, bottom]);
    }
    forced.sort((a, b) => a - b);
    const cuts = Array.from(new Set(solid.flatMap(([t, b]) => [Math.floor(t), Math.ceil(b)]))).sort((a, b) => b - a);

    const pages = [];
    let start = 0;
    while (start < total - 2) {
      const limit = Math.min(start + pageH, total);
      let end = limit;
      const f = forced.find((y) => y > start + 1 && y <= limit);
      if (f !== undefined) {
        end = Math.floor(f);
      } else if (limit < total) {
        const minEnd = start + pageH * 0.25;
        for (const c of cuts) {
          if (c > limit) continue;
          if (c <= minEnd) break;
          if (!solid.some(([t, b]) => t < c - 0.5 && b > c + 0.5)) { end = c; break; }
        }
      }
      if (end <= start) end = limit;
      pages.push([start, end]);
      start = end;
    }
    return pages.length ? pages : [[0, Math.max(total, 1)]];
  }

  /* ---------- HTML -> PDF ---------- */

  async function htmlToPdf(html, opts = {}) {
    await loadLibs();
    const g = geometry(opts.orientation);
    const frame = await mountFrame(html, g.cssW);
    try {
      const doc = frame.contentDocument;
      // Content wider than the page (a wide table) is shrunk to fit rather than cut off.
      const fullW = Math.max(g.cssW, doc.documentElement.scrollWidth, doc.body.scrollWidth);
      if (fullW > g.cssW + 1) {
        const ratio = g.cssW / fullW;
        doc.body.style.setProperty('width', fullW + 'px', 'important');
        frame.style.width = fullW + 'px';
        frame.style.height = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight) + 'px';
        g.ptPerPx = PX_TO_PT * ratio;
        g.cssH = Math.floor(g.cssH / ratio);
        g.cssW = fullW;
        await new Promise((r) => requestAnimationFrame(r));
      }
      const pages = planPages(doc, g.cssH);
      const totalH = pages[pages.length - 1][1];
      const { jsPDF } = root.jspdf;
      const pdf = new jsPDF({ orientation: g.land ? 'landscape' : 'portrait', unit: 'pt', format: 'a4', compress: true });
      pdf.setProperties({ title: opts.title || 'Calendar App report', creator: 'Calendar App' });
      const stamp = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

      // Render in chunks of whole pages, then slice each page out of its chunk.
      let i = 0;
      while (i < pages.length) {
        let j = i;
        while (j + 1 < pages.length && pages[j + 1][1] - pages[i][0] <= MAX_CHUNK_PX) j++;
        const y0 = pages[i][0];
        const y1 = pages[j][1];
        const chunk = await root.html2canvas(doc.body, {
          scale: SCALE, backgroundColor: '#ffffff', logging: false, useCORS: false,
          x: 0, y: y0, width: g.cssW, height: y1 - y0,
          windowWidth: g.cssW, windowHeight: Math.max(totalH, g.cssH), scrollX: 0, scrollY: 0,
        });
        for (let k = i; k <= j; k++) {
          const [a, b] = pages[k];
          const c = document.createElement('canvas');
          c.width = chunk.width;
          c.height = Math.max(1, Math.round((b - a) * SCALE));
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(chunk, 0, Math.round((a - y0) * SCALE), chunk.width, c.height, 0, 0, c.width, c.height);
          if (k > 0) pdf.addPage();
          pdf.addImage(c.toDataURL('image/jpeg', 0.9), 'JPEG', g.m, g.m, g.cssW * g.ptPerPx, (b - a) * g.ptPerPx, undefined, 'FAST');
          pdf.setFontSize(7.5);
          pdf.setTextColor(120);
          const footY = g.pageH - g.m + 4;
          pdf.text(`${opts.title || 'Calendar App'}  ·  ${stamp}`, g.m, footY);
          pdf.text(`Page ${k + 1} of ${pages.length}`, g.pageW - g.m, footY, { align: 'right' });
        }
        i = j + 1;
      }
      return { blob: pdf.output('blob'), pages: pages.length };
    } finally {
      frame.remove();
    }
  }

  /* ---------- share / save ---------- */

  function safeName(name) {
    const base = String(name || 'Report').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Report';
    return base.toLowerCase().endsWith('.pdf') ? base : base + '.pdf';
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function plugins() {
    const C = root.Capacitor;
    return root.SRG_NATIVE && C && C.Plugins ? C.Plugins : null;
  }

  async function share(blob, filename, title) {
    const P = plugins();
    if (P && P.Filesystem && P.Share) {
      const path = `reports/${filename}`;
      await P.Filesystem.writeFile({ path, data: await blobToBase64(blob), directory: 'CACHE', recursive: true });
      const { uri } = await P.Filesystem.getUri({ path, directory: 'CACHE' });
      try {
        await P.Share.share({ title, files: [uri], dialogTitle: 'Share PDF' });
      } catch (e) {
        if (!/cancel/i.test(String(e && e.message))) throw e;
      }
      return 'shared';
    }
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title });
        return 'shared';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
      }
    }
    download(blob, filename);
    return 'downloaded';
  }

  async function save(blob, filename) {
    const P = plugins();
    if (P && P.Filesystem) {
      await P.Filesystem.writeFile({ path: `${REPORTS_DIR}/${filename}`, data: await blobToBase64(blob), directory: 'DOCUMENTS', recursive: true });
      return 'saved';
    }
    download(blob, filename);
    return 'downloaded';
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function toast(msg, type, ms) {
    if (typeof root.showToast === 'function') return root.showToast(msg, type, ms);
    return null;
  }
  function untoast(t) {
    if (t && typeof root.dismissToast === 'function') root.dismissToast(t);
  }

  let busy = false;
  // action: 'share' | 'save'
  async function exportHtml(html, opts, action) {
    if (busy) return;
    busy = true;
    const filename = safeName(opts.filename || opts.title);
    const wait = toast('Creating PDF…', 'info', 0);
    try {
      const { blob, pages } = await htmlToPdf(html, opts);
      untoast(wait);
      const result = action === 'save' ? await save(blob, filename) : await share(blob, filename, opts.title || filename);
      if (result === 'saved') toast(`PDF saved (${pages} page${pages > 1 ? 's' : ''}): Documents › SRGCalendar › Reports › ${filename}`, 'success', 7000);
      else if (result === 'downloaded') toast(`PDF downloaded: ${filename}`, 'success', 5000);
    } catch (e) {
      untoast(wait);
      console.error('PDF export failed', e);
      toast('Could not create the PDF: ' + (e && e.message || e), 'error', 7000);
    } finally {
      busy = false;
    }
  }

  root.SRGPdf = { exportHtml, htmlToPdf, planPages, _geometry: geometry };
})(window);
