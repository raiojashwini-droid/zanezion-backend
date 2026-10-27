import express from 'express';
import * as authController from '../controllers/auth.controller.js';
import { validate } from '../middlewares/validate.middleware.js';
import { loginSchema, forgotPasswordSchema, resetPasswordSchema, changePasswordSchema, updateProfileSchema, refreshTokenSchema, signupSchema } from '../validators/auth.validator.js';
import { authenticate } from '../middlewares/auth.middleware.js';

import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safeExt = path.extname(file.originalname).toLowerCase() || '.bin';
    const prefix = file.fieldname === 'businessLicense'
      ? 'businessLicense_'
      : file.fieldname === 'profile_pic'
        ? 'profilePic_'
        : `${file.fieldname}_`;
    const randomHex = crypto.randomBytes(6).toString('hex');
    cb(null, `${prefix}${Date.now()}_${randomHex}${safeExt}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/signup', upload.single('businessLicense'), validate(signupSchema), authController.signup);
router.post('/staff-register', upload.fields([
  { name: 'passport', maxCount: 1 },
  { name: 'license', maxCount: 1 },
  { name: 'nib_doc', maxCount: 1 },
  { name: 'police_record', maxCount: 1 },
  { name: 'profile_pic', maxCount: 1 }
]), authController.staffRegister);
router.post('/login', validate(loginSchema), authController.login);
router.post('/refresh-token', validate(refreshTokenSchema), authController.refreshToken);
router.post('/forgot-password', validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);

// Protected routes
router.use(authenticate);
router.post('/logout', authController.logout);
router.get('/profile', authController.getProfile);
router.put('/profile', validate(updateProfileSchema), authController.updateProfile);
router.put('/change-password', validate(changePasswordSchema), authController.changePassword);

export default router;
