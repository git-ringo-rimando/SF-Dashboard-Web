import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconDir = path.join(__dirname, '../public/icons');

if (!fs.existsSync(iconDir)) {
  fs.mkdirSync(iconDir, { recursive: true });
}

function generateIcon(size, filename) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Dark background
  ctx.fillStyle = '#030712';
  ctx.fillRect(0, 0, size, size);

  // White "SF" text
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(size * 0.5)}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SF', size / 2, size / 2);

  // Write to file
  const buffer = canvas.toBuffer('image/png');
  const filepath = path.join(iconDir, filename);
  fs.writeFileSync(filepath, buffer);
  console.log(`✓ Generated ${filename}`);
}

generateIcon(192, 'icon-192.png');
generateIcon(512, 'icon-512.png');
generateIcon(180, 'apple-touch-icon.png');

console.log('✓ All icons generated successfully');
