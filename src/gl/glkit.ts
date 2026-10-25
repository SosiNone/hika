/** Minimal WebGL2 helpers: programs with uniform lookup, buffers, and 4×4 column-major matrices. */

export interface Program {
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation>;
  a: Record<string, number>;
}

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${gl.getShaderInfoLog(s)}\n${src}`);
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed');
  const u: Record<string, WebGLUniformLocation> = {}, a: Record<string, number> = {};
  for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(program, i)!.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(program, name)!;
  }
  for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES); i++) {
    const name = gl.getActiveAttrib(program, i)!.name;
    a[name] = gl.getAttribLocation(program, name);
  }
  return { program, u, a };
}

/** A VAO with one float buffer per attribute: `{ aPos: [data, size] }`. */
export function createVao(gl: WebGL2RenderingContext, p: Program, attribs: Record<string, [Float32Array, number]>): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  for (const [name, [data, size]] of Object.entries(attribs)) {
    const loc = p.a[name];
    if (loc === undefined || loc < 0) continue;
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
  gl.bindVertexArray(null);
  return vao;
}

export type Mat4 = Float32Array;

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

export function lookAt(eye: number[], target: number[], up = [0, 1, 0]): Mat4 {
  const z = norm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

/** Projects a world point to CSS pixels; `w <= 0` means behind the camera. */
export function project(m: Mat4, x: number, y: number, z: number, width: number, height: number): { x: number; y: number; w: number; depth: number } {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return { x: ((cx / w) * 0.5 + 0.5) * width, y: (1 - ((cy / w) * 0.5 + 0.5)) * height, w, depth: cz / w };
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** Resizes a canvas to its CSS box at the device pixel ratio; returns true when the size changed. */
export function fitCanvas(canvas: HTMLCanvasElement, maxDpr = 2): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}
