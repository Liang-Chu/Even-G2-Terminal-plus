import { ListContainerProperty, ListItemContainerProperty, TextContainerProperty, ImageContainerProperty,
  MenuContainerProperty, MenuItemProperty } from "@evenrealities/even_hub_sdk";
import { G2_IMAGE_REGIONS, G2_READING_PADDING } from "./renderer.js";
import { LIST_ROW_WIDTH, listLabel, nativeTextPrefix } from "./messages.js";
import { getTextWidth } from "@evenrealities/pretext";
import { fitText } from "./renderer.js";

export const SESSIONS_MENU_ID = 1;
export const SEND_MENU_ID = 2;
export const BACK_MENU_ID = 3;
export const STOP_MENU_ID = 4;
export const PREVIOUS_PART_MENU_ID = 5;
export const NEXT_PART_MENU_ID = 6;
export const GESTURE_CONTAINER_ID = 8;
export const CONFIRM_CONTAINER_ID = 9;

export interface NativeListEntry { key?: string; page?: number; label: string }
export interface NativeFrame {
  body: string; entries?: NativeListEntry[]; layoutKey: string; picker?: boolean; heading?: string; sessionKey?: string;
  detail?: { previous: boolean; next: boolean };
  conversationList?: boolean; confirmation?: boolean; plain?: boolean; footer?: string;
}
export interface NativeText { id: number; name: string; content: string; color?: number }
export function nativeTexts(frame: NativeFrame): NativeText[] {
  if (frame.entries) return [];
  return [{ id: 1, name: "pilot-body", content: frame.body, color: 4 },
    ...(frame.plain ? [{ id: 6, name: "pilot-heading", content: frame.heading || "Even-Pilot", color: 4 },
      { id: 7, name: "pilot-hint", content: frame.footer || "Double: back", color: 4 }] : [])];
}

/** Session identity changes content, not the terminal's container/menu layout. */
export function nativeLayoutKey(frame: NativeFrame): string {
  if (frame.plain) return "plain:" + frame.layoutKey;
  if (frame.entries || frame.picker || frame.detail) return frame.layoutKey;
  return frame.layoutKey.startsWith("composer:") ? "composer" : "terminal";
}

/** Keep existing Sessions/basic-view labels conservative; conversation rows use pixel width. */
export const nativeLabel = (text: string) => listLabel(text, "", "", 63);
// A text heading is not a list item: no 63-byte compatibility label limit.
export const nativeHeading = (text: string) => fitText(text.replace(/\s+/g, " ").trim(), getTextWidth, 560);

/** Keep the latest part within the SDK's 2,000-character upgrade limit. */
export function nativeBody(text: string): string {
  if (text.length <= 1950) return text || " ";
  let start = text.length - 1900;
  if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
  return "… Earlier text in Terminal.\n" + text.slice(start);
}

export function nativeLayout(frame: NativeFrame) {
  const composer = frame.layoutKey.startsWith("composer:");
  const terminate = new MenuItemProperty({ itemID: STOP_MENU_ID, itemName: "Terminate task" });
  const menuObject = new MenuContainerProperty({ menuItems: frame.confirmation
    ? [new MenuItemProperty({ itemID: BACK_MENU_ID, itemName: "Back" })] : [
    // Firmware adds its own menu rows; keep interruption first among app actions.
    ...(!composer && (!frame.picker || frame.conversationList) ? [terminate] : []),
    new MenuItemProperty({ itemID: composer || frame.detail ? BACK_MENU_ID : SESSIONS_MENU_ID, itemName: composer || frame.detail ? "Back" : "Sessions" }),
    ...(composer ? [new MenuItemProperty({ itemID: SEND_MENU_ID, itemName: "Send" })] : []),
    ...(frame.detail?.previous ? [new MenuItemProperty({ itemID: PREVIOUS_PART_MENU_ID, itemName: "Previous part" })] : []),
    ...(frame.detail?.next ? [new MenuItemProperty({ itemID: NEXT_PART_MENU_ID, itemName: "Next part" })] : []),
    ...(composer || frame.detail ? [new MenuItemProperty({ itemID: SESSIONS_MENU_ID, itemName: "Sessions" })] : []),
  ] });
  const common = { xPosition: 8, yPosition: 38, width: LIST_ROW_WIDTH, height: 222, borderWidth: 0, paddingLength: 0 };
  if (frame.picker) return {
    containerTotalNum: 3, menuObject,
    ...(frame.entries ? { listObject: [new ListContainerProperty({ ...common,
      containerID: frame.confirmation ? CONFIRM_CONTAINER_ID : frame.conversationList ? GESTURE_CONTAINER_ID : 1,
      containerName: frame.confirmation ? "pilot-confirm" : frame.conversationList ? "pilot-messages" : "pilot-sessions",
      zOrderIndex: 0, isEventCapture: 1, itemContainer: new ListItemContainerProperty({ itemCount: frame.entries.length,
        itemWidth: LIST_ROW_WIDTH, isItemSelectBorderEn: 1, itemName: frame.entries.map(entry => entry.label) }) })] } : {}),
    textObject: [
      ...(!frame.entries ? [new TextContainerProperty({ ...common, containerID: 1, containerName: "pilot-body", zOrderIndex: 0, isEventCapture: 1, content: frame.body })] : []),
      new TextContainerProperty({ xPosition: 8, yPosition: 0, width: 560, height: 32,
        borderWidth: 0, paddingLength: 0, containerID: 6, containerName: "pilot-heading", zOrderIndex: 1, isEventCapture: 0, content: frame.heading || "Sessions" }),
      new TextContainerProperty({ xPosition: 8, yPosition: 262, width: 560, height: 26,
        borderWidth: 0, paddingLength: 0, containerID: 7, containerName: "pilot-hint", zOrderIndex: 2, isEventCapture: 0, content: frame.footer || "Tap: select / retry · Double tap: back" }),
    ],
  };
  const texts = nativeTexts(frame);
  if (frame.plain) return { containerTotalNum: 3, menuObject,
    textObject: texts.map((text, index) => new TextContainerProperty({ ...common,
      ...(frame.detail && index === 0 ? { paddingLength: G2_READING_PADDING } : {}),
      ...(index === 1 ? { yPosition: 0, height: 32 } : index === 2 ? { yPosition: 262, height: 26 } : {}),
      containerID: text.id, containerName: text.name, zOrderIndex: index,
      isEventCapture: index === 0 ? 1 : 0, content: nativeTextPrefix(text.content), textColor: 4,
    })),
  };
  const textObject = texts.map((text, index) => {
    return new TextContainerProperty({ ...common,
      ...(frame.detail ? { paddingLength: G2_READING_PADDING } : {}),
      containerID: text.id, containerName: text.name, zOrderIndex: index + 5,
      isEventCapture: frame.detail ? 1 : 0, textColor: text.color,
      content: nativeTextPrefix(text.content),
    });
  });
  // Keep a native text region in mixed list/image pages, as in other native
  // apps. It is static, behind the heading strips, and never captures
  // gestures. Image-free recovery keeps it too; a list alone is not equivalent.
  if (frame.conversationList) textObject.unshift(new TextContainerProperty({
    xPosition: 8, yPosition: 0, width: 560, height: 32, borderWidth: 0, paddingLength: 0,
    containerID: 6, containerName: "pilot-heading", zOrderIndex: 0, isEventCapture: 0, content: " " }));
  // The editor captures gestures separately from its visible text. Conversation
  // selection belongs entirely to the visible native list, including highlight.
  if (!frame.detail && !frame.conversationList) textObject.unshift(new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: 288, borderWidth: 0, paddingLength: 0,
    containerID: GESTURE_CONTAINER_ID, containerName: "pilot-gestures", zOrderIndex: 0, isEventCapture: 1, content: " " }));
  const listObject = frame.conversationList ? [new ListContainerProperty({ ...common,
    containerID: GESTURE_CONTAINER_ID, containerName: "pilot-messages", zOrderIndex: 5, isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({ itemCount: frame.entries!.length,
      itemWidth: LIST_ROW_WIDTH, isItemSelectBorderEn: 1, itemName: frame.entries!.map(entry => entry.label) }),
  })] : [];
  return { containerTotalNum: textObject.length + listObject.length + G2_IMAGE_REGIONS.length, menuObject, textObject,
    ...(listObject.length ? { listObject } : {}),
    imageObject: G2_IMAGE_REGIONS.map((region, index) => new ImageContainerProperty({
      xPosition: region.x, yPosition: region.y, width: region.width, height: region.height,
      containerID: index + 2, containerName: `pilot-img-${index}`, zOrderIndex: index + 1,
    })),
  };
}
