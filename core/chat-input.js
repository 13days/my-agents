function imageContent(images = []) {
  if (!Array.isArray(images) || images.length > 4) throw new Error('最多附带 4 张图片');
  return images.map(image => {
    if (!image || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType) || typeof image.data !== 'string' || !image.data.length || image.data.length > Math.ceil(5 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('图片格式无效或超过 5 MB');
    return { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } };
  });
}
function imageMessage(prompt, content, gatewayContext = '') {
  return { type: 'user', message: { role: 'user', content: [...(gatewayContext ? [{ type: 'text', text: gatewayContext }] : []), ...content.flatMap((image, i) => [{ type: 'text', text: `[Image #${i + 1}]` }, image]), { type: 'text', text: prompt || '请查看这些图片。' }] } };
}
module.exports = { imageContent, imageMessage };
