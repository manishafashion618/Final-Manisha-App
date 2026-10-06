import type { Request, Response } from 'express';
import * as codService from '../services/cod.service';
import { asyncHandler } from '../utils/asyncHandler';

/* ── Admin: per-state COD settings (PRD 4.4 / 6) ────────────────────────── */

export const list = asyncHandler(async (_req: Request, res: Response) => {
  res.success(await codService.listStateConfigs());
});

export const upsert = asyncHandler(async (req: Request, res: Response) => {
  res.success(
    await codService.upsertStateConfig(req.params.state, {
      codEnabled: req.body.codEnabled,
      codCharge: req.body.codCharge,
      // Forwarded only when the request actually carried it. Zod drops absent
      // optional keys, so this is what tells a deliberate "follow the default"
      // (null) apart from an older admin build that knows nothing about
      // prepaid pricing — whose save must not wipe the stored amount.
      ...('prepaidCharge' in req.body ? { prepaidCharge: req.body.prepaidCharge } : {}),
    }),
  );
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  res.success(await codService.deleteStateConfig(req.params.state));
});

/* ── Customer: what COD costs for one saved address ─────────────────────── */

export const optionsForAddress = asyncHandler(async (req: Request, res: Response) => {
  const { addressId } = req.query as unknown as { addressId: string };
  res.success(await codService.codOptionsForAddress(req.user!.id, addressId));
});
