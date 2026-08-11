import assert from "node:assert/strict";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, useRenderer, useSelectionHandler } from "@opentui/react";

const test = await createTestRenderer({
  width: 80,
  height: 18,
  useMouse: true,
  screenMode: "alternate-screen",
});
const root = createRoot(test.renderer);
let selectionText = "";

function NativeInteractionHarness() {
  const renderer = useRenderer();
  useSelectionHandler(selection => {
    selectionText = selection.getSelectedText();
  });
  return (
    <box width="100%" height="100%" flexDirection="column" onMouseUp={() => {
      selectionText = renderer.getSelection()?.getSelectedText() ?? "";
    }}>
      <scrollbox
        id="e2e-scroll"
        height={12}
        scrollY
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        focused
      >
        {Array.from({ length: 40 }, (_, index) => (
          <text key={`line-${index}`} selectionBg="#264f78" selectionFg="#ffffff">
            line-{String(index).padStart(2, "0")} selectable content
          </text>
        ))}
      </scrollbox>
      <text selectable={false}>footer</text>
    </box>
  );
}

try {
  root.render(<NativeInteractionHarness />);
  await test.flush();

  const bottomFrame = test.captureCharFrame();
  assert.match(bottomFrame, /line-39/);

  await test.mockMouse.scroll(10, 5, "up");
  await test.mockMouse.scroll(10, 5, "up");
  await test.flush();
  const scrolledFrame = test.captureCharFrame();
  assert.notEqual(scrolledFrame, bottomFrame, "mouse wheel must change the ScrollBox viewport");
  assert.doesNotMatch(scrolledFrame, /PS [A-Z]:\\|npm run build|正在使用.*启动/, "TUI viewport must not contain shell history");

  await test.mockMouse.drag(2, 4, 18, 4);
  await test.flush();
  assert.notEqual(selectionText.trim(), "", "renderer drag selection must produce text");
  assert.equal(test.renderer.getSelection()?.getSelectedText(), selectionText);

  process.stdout.write("OPENTUI_E2E_OK\n");
} finally {
  test.renderer.destroy();
}
