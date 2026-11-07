/**
 * Double-Buffered Differential Terminal Rendering Engine
 * 
 * Compares back buffer against front buffer cell-by-cell and emits minimal
 * ANSI cursor-jump sequences (\x1b[Row;ColH) exclusively for modified cells.
 * Eliminates screen tearing, flickering, and redundant stdout writes at 15 FPS.
 */

export interface Cell {
  char: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

export class DifferentialTerminalEngine {
  private width: number;
  private height: number;
  private frontBuffer: Cell[][];
  private backBuffer: Cell[][];
  private outWriter: (data: string) => void;

  constructor(width = 120, height = 40, outWriter?: (data: string) => void) {
    this.width = width;
    this.height = height;
    this.outWriter = outWriter || ((data) => {
      try {
        process.stdout.write(data);
      } catch {}
    });
    this.frontBuffer = this.createEmptyMatrix();
    this.backBuffer = this.createEmptyMatrix();
  }

  public getWidth(): number {
    return this.width;
  }

  public getHeight(): number {
    return this.height;
  }

  private createEmptyMatrix(): Cell[][] {
    return Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ char: " " }))
    );
  }

  public resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    this.frontBuffer = this.createEmptyMatrix();
    this.backBuffer = this.createEmptyMatrix();
    this.outWriter("\x1b[2J\x1b[H");
  }

  public setCell(x: number, y: number, cell: Cell): void {
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
      this.backBuffer[y][x] = cell;
    }
  }

  public writeString(
    x: number,
    y: number,
    text: string,
    fg?: string,
    bg?: string,
    bold?: boolean
  ): void {
    if (y < 0 || y >= this.height) return;
    let curX = x;
    for (const char of text) {
      if (curX >= this.width) break;
      if (curX >= 0) {
        this.setCell(curX, y, { char, fg, bg, bold });
      }
      curX++;
    }
  }

  public clearBackBuffer(): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        this.backBuffer[y][x] = { char: " " };
      }
    }
  }

  public drawBox(
    startX: number,
    startY: number,
    width: number,
    height: number,
    title?: string,
    borderFg: string = "\x1b[90m" // Gray
  ): void {
    if (width < 2 || height < 2) return;
    const endX = Math.min(this.width - 1, startX + width - 1);
    const endY = Math.min(this.height - 1, startY + height - 1);

    // Top border
    this.setCell(startX, startY, { char: "┌", fg: borderFg });
    for (let x = startX + 1; x < endX; x++) {
      this.setCell(x, startY, { char: "─", fg: borderFg });
    }
    this.setCell(endX, startY, { char: "┐", fg: borderFg });

    // Side borders
    for (let y = startY + 1; y < endY; y++) {
      this.setCell(startX, y, { char: "│", fg: borderFg });
      this.setCell(endX, y, { char: "│", fg: borderFg });
    }

    // Bottom border
    this.setCell(startX, endY, { char: "└", fg: borderFg });
    for (let x = startX + 1; x < endX; x++) {
      this.setCell(x, endY, { char: "─", fg: borderFg });
    }
    this.setCell(endX, endY, { char: "┘", fg: borderFg });

    // Title insertion
    if (title && startX + 2 < endX) {
      const truncatedTitle = ` ${title} `.slice(0, endX - startX - 2);
      this.writeString(startX + 2, startY, truncatedTitle, "\x1b[1m\x1b[36m", undefined, true);
    }
  }

  /**
   * Flushes only mutated cells using minimal ANSI escape sequences.
   * Completely eliminates visual tearing and full-screen flashing.
   */
  public flush(): number {
    let diffBuffer = "";
    let mutatedCount = 0;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const back = this.backBuffer[y][x];
        const front = this.frontBuffer[y][x];

        // Cell inequality check
        if (
          back.char !== front.char ||
          back.fg !== front.fg ||
          back.bg !== front.bg ||
          back.bold !== front.bold
        ) {
          mutatedCount++;
          // Cursor move: \x1b[row;colH (1-indexed)
          diffBuffer += `\x1b[${y + 1};${x + 1}H`;

          // Apply styling
          if (back.bold) diffBuffer += "\x1b[1m";
          if (back.fg) diffBuffer += back.fg;
          if (back.bg) diffBuffer += back.bg;
          diffBuffer += back.char;
          diffBuffer += "\x1b[0m"; // Reset styling

          // Synchronize front buffer
          this.frontBuffer[y][x] = { ...back };
        }
      }
    }

    if (diffBuffer.length > 0) {
      this.outWriter(diffBuffer);
    }

    return mutatedCount;
  }
}
