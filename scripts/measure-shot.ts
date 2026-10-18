import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const data = await readFile('artifacts/official-39148900576/outputs/output-1100.jpg');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const panels = [];
    for (const base of [0, 1102]) {
      const runs = [];
      let start = -1;
      for (let y = 0; y < canvas.height; y++) {
        let count = 0;
        for (let x = base; x < base + 1100; x++) {
          const i = (y * canvas.width + x) * 4; if (pixels[i] < 220 || pixels[i + 1] < 220 || pixels[i + 2] < 220) count++;
        }
        const filled = count > 500;
        if (filled && start < 0) start = y;
        if (!filled && start >= 0) { runs.push({ top: start, bottom: y - 1 }); start = -1; }
      }
      let circleTop = -1;
      for (let y = 2020; y < Math.min(2600, canvas.height); y++) {
        const i = (y * canvas.width + base + 190) * 4;
        if (pixels[i] < 40 && pixels[i + 1] < 40 && pixels[i + 2] < 40) { circleTop = y; break; }
      }
      let logo = { left: 1100, right: 0, top: 300, bottom: 0 };
      for (let y = 40; y < 250; y++) for (let x = 450; x < 650; x++) {
        const i = (y * canvas.width + base + x) * 4;
        if (pixels[i] < 60 && pixels[i+1] < 60 && pixels[i+2] < 60) {
          logo.left = Math.min(logo.left, x); logo.right = Math.max(logo.right, x);
          logo.top = Math.min(logo.top, y); logo.bottom = Math.max(logo.bottom, y);
        }
      }
      const textRows = [];
      for (let y = 2100; y < Math.min(2900, canvas.height); y++) {
        let ink = 0;
        for (let x = 383; x < 1076; x++) { const i = (y * canvas.width + base + x) * 4; if (pixels[i] < 90 && pixels[i+1] < 90 && pixels[i+2] < 90) ink++; }
        if (ink > 20 && (!textRows.length || textRows[textRows.length-1].bottom < y-1)) textRows.push({top:y,bottom:y});
        else if (ink > 20) textRows[textRows.length-1].bottom=y;
      }
      const heroRows: Array<{top:number;bottom:number;left:number;right:number}> = [];
      for (let y = 400; y < 1030; y++) {
        let ink=0, left=1100, right=0;
        for (let x=40;x<1060;x++) {const i=(y*canvas.width+base+x)*4;if(pixels[i]>220&&pixels[i+1]>220&&pixels[i+2]>220){ink++;left=Math.min(left,x);right=Math.max(right,x);}}
        if(ink>50&&(!heroRows.length||heroRows[heroRows.length-1].bottom<y-1))heroRows.push({top:y,bottom:y,left,right});
        else if(ink>50){const last=heroRows[heroRows.length-1];last.bottom=y;last.left=Math.min(left,last.left);last.right=Math.max(right,last.right);}
      }
      panels.push({ base, filledRows: runs.filter(r => r.bottom - r.top > 10), circleTop, logo, textRows:textRows.slice(0,14),heroRows });
    }
    return { width: image.width, height: image.height, panels };
  }, `data:image/jpeg;base64,${data.toString('base64')}`);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
