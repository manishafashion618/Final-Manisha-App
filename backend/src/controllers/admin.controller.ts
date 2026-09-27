import type { Request, Response } from 'express';
import * as adminService from '../services/admin.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import type { WholesaleStatus } from '../types';

export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  res.success(await adminService.getDashboard(req.user!));
});

/* ── Wholesale approvals ────────────────────────────────────────────────── */

export const listWholesale = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as {
    page: number;
    limit: number;
    status?: WholesaleStatus;
  };
  const result = await adminService.listWholesaleApplications(query);
  res.success(result.items, result.pagination);
});

export const reviewWholesale = asyncHandler(async (req: Request, res: Response) => {
  res.success(
    await adminService.reviewWholesaleApplication(
      req.user!,
      req.params.userId,
      req.body.decision,
      req.body.reason,
    ),
  );
});

/* ── Accounts ───────────────────────────────────────────────────────────── */

export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as {
    page: number;
    limit: number;
    accountType?: string;
    search?: string;
  };
  const result = await adminService.listUsers(query);
  res.success(result.items, result.pagination);
});

export const setRole = asyncHandler(async (req: Request, res: Response) => {
  res.success(await adminService.setAccountRole(req.user!, req.params.userId, req.body.accountType));
});

export const setActive = asyncHandler(async (req: Request, res: Response) => {
  res.success(await adminService.setAccountActive(req.user!, req.params.userId, req.body.isActive));
});


export const roleChanges = asyncHandler(async (_req: Request, res: Response) => {
  res.success(await adminService.listRoleChanges());
});
