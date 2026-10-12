'use strict';

const archiver = require('archiver');

/**
 * Files → .zip buffer, all under one root folder. Paths were validated by
 * project.js (generated files) or built by the server (bundled images).
 */
function zipFiles(files, rootDir) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    files.forEach((f) => {
      const body = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
      archive.append(body, { name: `${rootDir}/${f.path}` });
    });
    archive.finalize();
  });
}

module.exports = { zipFiles };
