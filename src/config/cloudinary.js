import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
dotenv.config();

const cleanEnv = (val) => (val ? String(val).replace(/^["']|["']$/g, '').trim() : '');

cloudinary.config({
  cloud_name: cleanEnv(process.env.CLOUDINARY_CLOUD_NAME),
  api_key: cleanEnv(process.env.CLOUDINARY_API_KEY),
  api_secret: cleanEnv(process.env.CLOUDINARY_API_SECRET)
});

export const CLOUDINARY_FOLDER = cleanEnv(process.env.CLOUDINARY_FOLDER) || 'zanezion';

export default cloudinary;
