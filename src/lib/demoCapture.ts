import type { CapturePayload } from "../types/session";

export function createDemoCapture(): CapturePayload {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const context = canvas.getContext("2d")!;

  const sky = context.createLinearGradient(0, 0, 0, 1080);
  sky.addColorStop(0, "#334d65");
  sky.addColorStop(1, "#8fb3b2");
  context.fillStyle = sky;
  context.fillRect(0, 0, 1920, 1080);

  context.fillStyle = "#f0c86b";
  context.beginPath();
  context.arc(1460, 230, 116, 0, Math.PI * 2);
  context.fill();

  drawMountain(context, "#263c40", [
    [0, 640], [340, 370], [620, 624], [910, 274], [1290, 634], [1550, 424], [1920, 684],
  ]);
  drawMountain(context, "#18292d", [
    [0, 760], [370, 540], [620, 745], [960, 495], [1288, 755], [1618, 550], [1920, 770],
  ]);

  context.fillStyle = "#60686c";
  context.beginPath();
  context.moveTo(520, 1080);
  context.lineTo(840, 640);
  context.lineTo(1080, 640);
  context.lineTo(1400, 1080);
  context.fill();

  context.fillStyle = "#d8b85e";
  context.beginPath();
  context.arc(960, 900, 74, 0, Math.PI * 2);
  context.fill();

  label(context, 70, 70, 420, 78, "DEMO CHECKPOINT");
  label(context, 1570, 74, 274, 92, "NORTH PASS");

  return {
    dataUrl: canvas.toDataURL("image/png"),
    capturedAt: new Date().toISOString(),
    monitorName: "QA display",
    width: 1920,
    height: 1080,
  };
}

function drawMountain(
  context: CanvasRenderingContext2D,
  fill: string,
  points: Array<[number, number]>,
) {
  context.fillStyle = fill;
  context.beginPath();
  points.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
  context.lineTo(1920, 1080);
  context.lineTo(0, 1080);
  context.closePath();
  context.fill();
}

function label(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
) {
  context.fillStyle = "rgba(16, 24, 32, .76)";
  context.fillRect(x, y, width, height);
  context.fillStyle = "#f5f7f8";
  context.font = "34px Segoe UI, sans-serif";
  context.fillText(text, x + 32, y + 52);
}
