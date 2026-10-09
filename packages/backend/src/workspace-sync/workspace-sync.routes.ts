import express from 'express';
import { workspaceSyncController } from './workspace-sync.controller';
import { isAuthenticated } from '../auth/auth.middleware';

const router = express.Router();

router.get('/', isAuthenticated, (req, res) => workspaceSyncController.getState(req, res));
router.post('/claim', isAuthenticated, (req, res) => workspaceSyncController.claimLease(req, res));
router.post('/save', isAuthenticated, (req, res) => workspaceSyncController.saveState(req, res));

export default router;
