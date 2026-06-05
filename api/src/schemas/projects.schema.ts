/**
 * F8: zod schemas for /projects route group.
 */

import { z } from "zod";
import { TenantIdSchema } from "../lib/zod-helpers";

const TenantPyramidIdSchema = z.string().min(1).max(120);

export const CreateProjectSchema = z.object({
  label: z.string().min(1, { message: "label is required" }).max(120),
  tenant_id: TenantIdSchema,
  description: z.string().max(4000).optional(),
  tenant_pyramid_id: z.string().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectSchema>;

export const RenameProjectSchema = z.object({
  label: z.string().min(1, { message: "label is required" }).max(120),
  tenant_id: TenantIdSchema,
});
export type RenameProjectRequest = z.infer<typeof RenameProjectSchema>;

export const ArchiveProjectSchema = z.object({
  tenant_id: TenantIdSchema,
});
export type ArchiveProjectRequest = z.infer<typeof ArchiveProjectSchema>;

export const MoveProjectSchema = z.object({
  tenant_id: TenantIdSchema,
  tenant_pyramid_id: TenantPyramidIdSchema,
});
export type MoveProjectRequest = z.infer<typeof MoveProjectSchema>;

export const DescribeProjectSchema = z.object({
  tenant_id: TenantIdSchema,
  description: z.string().nullable(),
});
export type DescribeProjectRequest = z.infer<typeof DescribeProjectSchema>;
