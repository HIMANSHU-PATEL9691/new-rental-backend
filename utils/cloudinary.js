const cloudinary = require('cloudinary').v2;
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'xj8uhkhu',
  api_key: process.env.CLOUDINARY_API_KEY || '127888696984154',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'FfEOY26Cxk1-8WG1YYg3m-rp4F8',
  secure: true,
});

/**
 * Upload a buffer or base64 string to Cloudinary
 * @param {Buffer|string} fileSource - Buffer or base64 data URI
 * @param {string} folder - Folder name in Cloudinary (default: 'rental_items')
 * @returns {Promise<string>} - The secure HTTPS URL of the uploaded image
 */
function uploadToCloudinary(fileSource, folder = 'rental_items') {
  return new Promise((resolve, reject) => {
    if (typeof fileSource === 'string' && fileSource.startsWith('data:')) {
      cloudinary.uploader.upload(
        fileSource,
        {
          folder,
          resource_type: 'image',
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result.secure_url);
        }
      );
    } else if (Buffer.isBuffer(fileSource)) {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result.secure_url);
        }
      );
      uploadStream.end(fileSource);
    } else {
      reject(new Error('Invalid file source provided to uploadToCloudinary'));
    }
  });
}

/**
 * Extract Cloudinary public_id from full URL
 * @param {string} url - e.g. "https://res.cloudinary.com/xj8uhkhu/image/upload/v1791282003/rental_items/xqyylqcll72jmyixy5nk.jpg"
 * @returns {string|null} - e.g. "rental_items/xqyylqcll72jmyixy5nk"
 */
function getPublicIdFromUrl(url) {
  if (!url || typeof url !== 'string' || !url.includes('cloudinary.com')) {
    return null;
  }
  try {
    const uploadIndex = url.indexOf('/upload/');
    if (uploadIndex === -1) return null;

    let pathAfterUpload = url.substring(uploadIndex + '/upload/'.length);
    // Remove version prefix like v1791282003/
    pathAfterUpload = pathAfterUpload.replace(/^v\d+\//, '');

    // Remove file extension
    const lastDotIndex = pathAfterUpload.lastIndexOf('.');
    if (lastDotIndex !== -1) {
      pathAfterUpload = pathAfterUpload.substring(0, lastDotIndex);
    }
    return pathAfterUpload || null;
  } catch {
    return null;
  }
}

/**
 * Delete image from Cloudinary by URL or public_id
 * @param {string} urlOrPublicId
 * @returns {Promise<any>}
 */
async function deleteFromCloudinary(urlOrPublicId) {
  if (!urlOrPublicId || typeof urlOrPublicId !== 'string') return null;

  const publicId = urlOrPublicId.includes('cloudinary.com')
    ? getPublicIdFromUrl(urlOrPublicId)
    : urlOrPublicId;

  if (!publicId) return null;

  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image',
      invalidate: true,
    });
    console.info(`[Cloudinary] Deleted image: ${publicId}`, result);
    return result;
  } catch (err) {
    console.warn(`[Cloudinary] Failed to delete image: ${publicId}`, err.message);
    return null;
  }

}

module.exports = {
  cloudinary,
  uploadToCloudinary,
  getPublicIdFromUrl,
  deleteFromCloudinary,
};
