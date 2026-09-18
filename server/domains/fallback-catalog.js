'use strict';
// Built-in copy of the tool families, used only when the Tools catalog has never been reachable
// since this process started. Deliberately short: every family and its best-known tools, all on
// hosts that exist today. The live catalog (openvibe.tools/api/catalog.json) replaces it.
const Z = 'openvibe.tools';
const tool = (family, id, name, tagline, icon, host) => ({
    id, family, name, tagline, description: '', keywords: [], icon,
    hosts: { canonical: `${host || id}.${Z}`, short: '', aliases: [] },
    url: `https://${host || id}.${Z}/`,
});
const family = (id, name, tagline, icon, host, path) => ({
    id, name, tagline, description: '', icon, url: host ? `https://${host}.${Z}/` : `https://${Z}${path}`, path,
});

module.exports = {
    updated: '2026-09-18T00:00:00Z',
    builtin: true,
    families: [
        family('net', 'Network Tools', 'Look up, test and debug anything on the internet', 'network', 'net', '/network-tools'),
        family('dev', 'Developer Tools', 'Formatters, encoders, validators and generators', 'code', 'dev', '/developer-tools'),
        family('img', 'Image Tools', 'Convert, resize, compress and clean up images', 'image', 'img', '/image-tools'),
        family('audio', 'Audio Tools', 'Convert, trim and reshape audio', 'audio', 'audio', '/audio-tools'),
        family('docs', 'PDF & Document Tools', 'Merge, split, protect and convert PDFs and documents', 'pdf', 'docs', '/pdf-tools'),
        family('text', 'Text & Logo Tools', 'Fancy text, case and count tools, wordmarks and badges', 'text', 'text', '/text-tools'),
        family('media', 'Video Tools', 'Save and convert video', 'youtube', null, '/video-tools'),
        family('maps', 'Maps & Food', 'Maps, places and what to eat', 'map', 'maps', '/maps-and-food'),
    ],
    tools: [
        tool('net', 'dns', 'DNS Lookup', 'Every record type for any domain', 'dns'),
        tool('net', 'whois', 'Whois Lookup', 'Who registered a domain, and when', 'whois'),
        tool('net', 'myip', 'What Is My IP', 'Your public address and what it reveals', 'ip'),
        tool('net', 'ssl', 'SSL Certificate Checker', 'Expiry, issuer and chain of any certificate', 'ssl'),
        tool('net', 'ping', 'Ping Test', 'Reachability and round-trip time', 'ping'),
        tool('net', 'traceroute', 'Traceroute', 'Every hop between us and a host', 'network'),
        tool('net', 'port', 'Port Checker', 'Is a port open from the outside', 'network'),
        tool('net', 'headers', 'HTTP Header Checker', 'The response headers a URL sends', 'network'),

        tool('dev', 'jsonfmt', 'JSON Formatter', 'Format, validate and minify JSON', 'json'),
        tool('dev', 'base64', 'Base64 Encoder & Decoder', 'Text to Base64 and back', 'code'),
        tool('dev', 'jwt', 'JWT Decoder', 'Read a token\'s header, claims and expiry', 'code'),
        tool('dev', 'regex', 'Regex Tester', 'Try a pattern against real text', 'code'),
        tool('dev', 'uuid', 'UUID Generator', 'Random v4 identifiers, one or many', 'code'),
        tool('dev', 'hash', 'Hash Generator', 'SHA-1, SHA-256 and SHA-512 of any text', 'code'),
        tool('dev', 'timestamp', 'Unix Timestamp Converter', 'Epoch seconds to dates and back', 'code'),
        tool('dev', 'pastes', 'Pastes', 'Share code and text with a link', 'paste'),

        tool('img', 'convert', 'Image Converter', 'Between PNG, JPG, WebP, HEIC, TIFF and SVG', 'image'),
        tool('img', 'resize', 'Image Resizer', 'Exact pixels or a percentage', 'image'),
        tool('img', 'compress', 'Image Compressor', 'Smaller files that look the same', 'image'),
        tool('img', 'crop', 'Image Cropper', 'Cut to a shape or an aspect ratio', 'image'),
        tool('img', 'png', 'PNG Converter', 'Any image to PNG', 'image'),
        tool('img', 'webp', 'WebP Converter', 'To and from WebP', 'image'),
        tool('img', 'heic', 'HEIC Converter', 'iPhone photos to JPG or PNG', 'image'),
        tool('img', 'favicon', 'Favicon Generator', 'Every icon size a site needs', 'image'),

        tool('audio', 'mp3', 'MP3 Converter', 'Any audio file to MP3', 'audio'),
        tool('audio', 'wav', 'WAV Converter', 'Any audio file to WAV', 'audio'),
        tool('audio', 'trim', 'Audio Trimmer', 'Cut a clip out of a recording', 'audio'),
        tool('audio', 'speed', 'Audio Speed Changer', 'Play a track faster or slower', 'audio'),
        tool('audio', 'pitch', 'Pitch Shifter', 'Move a track up or down in key', 'audio'),
        tool('audio', 'vocal', 'Vocal Remover', 'Split vocals from the instrumental', 'audio'),
        tool('audio', 'normalize', 'Audio Normalizer', 'Even out the loudness', 'audio'),

        tool('docs', 'mergepdf', 'Merge PDF', 'Several PDFs into one', 'pdf'),
        tool('docs', 'splitpdf', 'Split PDF', 'Pull pages out of a PDF', 'pdf'),
        tool('docs', 'rotatepdf', 'Rotate PDF', 'Turn pages the right way up', 'pdf'),
        tool('docs', 'protectpdf', 'Protect PDF', 'Put a password on a PDF', 'pdf'),
        tool('docs', 'watermarkpdf', 'Watermark PDF', 'Stamp every page', 'pdf'),
        tool('docs', 'pdf2jpg', 'PDF to JPG', 'Every page as an image', 'pdf'),

        tool('text', 'fancy', 'Fancy Text', 'Unicode styles you can paste anywhere', 'text'),
        tool('text', 'case', 'Case Converter', 'UPPER, lower, Title and more', 'text'),
        tool('text', 'count', 'Word Counter', 'Words, characters and reading time', 'text'),
        tool('text', 'symbols', 'Symbols', 'Copy-and-paste symbols and arrows', 'text'),
        tool('text', 'kaomoji', 'Kaomoji', 'Japanese emoticons, ready to copy', 'text'),
        tool('text', 'wordmark', 'Wordmark Maker', 'A text logo in a minute', 'logo'),
        tool('text', 'logo', 'Logo Maker', 'A mark and a name, exported clean', 'logo'),
        tool('text', 'badge', 'Badge Maker', 'Badges and stickers from text', 'logo'),
        tool('text', 'thumbnail', 'Thumbnail Maker', 'Covers and channel art from text', 'logo'),

        tool('media', 'yt', 'YouTube Downloader', 'Save videos and audio from YouTube', 'youtube'),

        tool('maps', 'maps', 'Maps', 'Find places and get around', 'map'),
        tool('maps', 'food', 'Food', 'What to eat, and where', 'food'),
    ],
};
