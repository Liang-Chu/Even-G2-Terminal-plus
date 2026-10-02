/** Native message rows and expanded text are different controls. */
export function pageText(page: any): string {
  return page.textObject?.find((item: any) => item.containerID === 1)?.content
    ?? page.listObject?.[0]?.itemContainer?.itemName?.join("\n") ?? "";
}
