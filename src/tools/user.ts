import { z } from 'zod';
import { PERSON_VIEW_NOTE, SW_VIEWS, viewUser } from '../project.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { minifiedResult, pruneUndefined, resolveView, viewParam } from '@chrischall/mcp-utils';
import type { SplitwiseClient } from '../client.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';

export function registerUserTools(server: McpServer, client: SplitwiseClient): void {
  server.registerTool('sw_get_current_user', {
    description: "Get the authenticated Splitwise user's profile. Use the returned id when building custom expense splits. The compact default returns id, name (first_name + last_name joined), email and registration_status; pass view:'full' for Splitwise's raw record, which keeps first_name and last_name separate — the form sw_update_user takes.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      view: viewParam(SW_VIEWS, { note: PERSON_VIEW_NOTE }),
    },
  }, async ({ view }) => {
    const data = await client.request('GET', '/get_current_user');
    return minifiedResult(viewUser(resolveView(view, SW_VIEWS), data));
  });

  server.registerTool('sw_get_user', {
    description: "Get another Splitwise user's profile by id. Same shape as sw_get_current_user: the compact default merges first_name/last_name into name, and view:'full' keeps them separate.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      view: viewParam(SW_VIEWS, { note: PERSON_VIEW_NOTE }),
      id: z.number().describe('User ID'),
    },
  }, async ({ id, view }) => {
    const data = await client.request('GET', `/get_user/${id}`);
    return minifiedResult(viewUser(resolveView(view, SW_VIEWS), data));
  });

  server.registerTool('sw_update_user', {
    description: "Update the current user's profile fields. id must be the current user's id.",
    inputSchema: {
      id: z.number().describe("User ID (must be the current user's id)"),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().optional(),
      password: z.string().optional(),
      locale: z.string().optional(),
      default_currency: z.string().optional(),
      confirm: schemaConfirm,
    },
  }, async ({ id, first_name, last_name, email, password, locale, default_currency, confirm }) => {
    const body = pruneUndefined({ first_name, last_name, email, password, locale, default_currency });
    // Never echo the password in the dry-run preview.
    const previewBody = { ...body, ...(password !== undefined ? { password: '[hidden]' } : {}) };
    const gate = previewUnlessConfirmed(confirm, `Update current Splitwise user ${id} profile`, 'POST', `/update_user/${id}`, previewBody);
    if (gate) return gate;
    const data = await client.request('POST', `/update_user/${id}`, body);
    return minifiedResult(data);
  });
}
