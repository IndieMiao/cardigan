import {
  managedPmOffice,
  type OwnerMessagePort,
  ownerTextError,
  parseId,
} from "@cardigan/domain";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { defineTool } from "./types.js";

export function ownerMessageTool(options: OwnerMessagePort) {
  return defineTool({
    name: "send_owner_message",
    description:
      "Queue plain text for the bound owner in Feishu private chat. Managed PM Office only. No attachments, mentions or recipient arguments. Check the card timeline for delivery.",
    input: z
      .object({
        card_id: z.string(),
        text: z.string(),
        idempotency_key: z.string().min(1).max(128),
      })
      .strict(),
    handler: (input, ctx) => {
      if (
        !options.enqueueOwnerMessage ||
        !ctx.revalidateToken ||
        !managedPmOffice(ctx.identity.assignment)
      )
        throw ToolError.forbiddenTool("send_owner_message");
      const card = parseId("card", input.card_id);
      if (!card.ok) throw ToolError.validation("卡号无效");
      const error = ownerTextError(input.text);
      if (error) throw ToolError.validation(error);
      return options.enqueueOwnerMessage(
        ctx.identity.actor,
        { ...input, card_id: card.value.id },
        ctx.revalidateToken,
      );
    },
  });
}
