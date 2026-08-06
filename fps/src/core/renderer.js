// Thinking Break — instanced box renderer (WebGL2, no dependencies).
//
// Why hand-rolled instead of Three.js: the entire game is axis-aligned boxes,
// so one 36-vertex cube plus a per-instance attribute stream draws the whole
// world in a single call. That keeps the download at a few kilobytes of JS and
// the frame cost at one `bufferSubData` — which matters far more here than any
// feature a general-purpose engine would add.

import { frustumFromViewProj, mat4Multiply, mat4Perspective, mat4View, sphereInFrustum } from './math.js';

export const FLOATS_PER_INSTANCE = 10; // centre(3) + half(3) + colour(3) + yaw(1)
const MAX_INSTANCES = 6000;

const VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec3 a_center;
layout(location = 3) in vec3 a_half;
layout(location = 4) in vec3 a_color;
layout(location = 5) in float a_yaw;

uniform mat4 u_viewProj;
uniform vec3 u_eye;

out vec3 v_normal;
out vec3 v_color;
out float v_dist;

void main() {
  float c = cos(a_yaw);
  float s = sin(a_yaw);
  mat2 rot = mat2(c, -s, s, c);

  vec3 local = a_position * a_half * 2.0;
  vec2 xz = rot * local.xz;
  vec3 world = vec3(xz.x, local.y, xz.y) + a_center;

  vec2 nxz = rot * a_normal.xz;
  v_normal = normalize(vec3(nxz.x, a_normal.y, nxz.y));
  v_color = a_color;
  v_dist = length(world - u_eye);

  gl_Position = u_viewProj * vec4(world, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;

in vec3 v_normal;
in vec3 v_color;
in float v_dist;

uniform vec3 u_lightDir;
uniform vec3 u_fogColor;
uniform vec2 u_fogRange;   // (start, end); end <= start disables fog
uniform float u_exposure;

out vec4 fragColor;

void main() {
  vec3 n = normalize(v_normal);

  // Key light plus a hemispheric fill. The sky/ground split is what gives the
  // untextured boxes readable form without a second light or any shadow pass.
  float key = max(dot(n, u_lightDir), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 lit = v_color * (0.34 + 0.58 * key + 0.30 * hemi);

  // Cheap rim term so silhouettes stay legible against same-coloured geometry.
  lit += v_color * pow(1.0 - abs(n.y), 3.0) * 0.05;

  float fog = u_fogRange.y > u_fogRange.x
    ? clamp((v_dist - u_fogRange.x) / (u_fogRange.y - u_fogRange.x), 0.0, 1.0)
    : 0.0;
  vec3 rgb = mix(lit * u_exposure, u_fogColor, fog);

  fragColor = vec4(rgb, 1.0);
}`;

function buildCube() {
  // Six faces, two triangles each; positions in [-0.5, 0.5] so a_half doubles
  // straight into world size.
  const faces = [
    { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, -1, 1], [1, 1, -1], [1, 1, 1]] },
    { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, -1, -1], [-1, 1, 1], [-1, 1, -1]] },
    { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  ];
  const data = new Float32Array(36 * 6);
  let i = 0;
  for (const face of faces) {
    for (const v of face.v) {
      data[i++] = v[0] * 0.5; data[i++] = v[1] * 0.5; data[i++] = v[2] * 0.5;
      data[i++] = face.n[0]; data[i++] = face.n[1]; data[i++] = face.n[2];
    }
  }
  return data;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Thinking Break: shader compile failed — ${log}`);
  }
  return shader;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,       // resolution scaling is cheaper than MSAA here
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      desynchronized: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');

    this.canvas = canvas;
    this.gl = gl;
    this.pixelRatioCap = 1.5;
    this.renderScale = 1;
    this.drawnInstances = 0;
    this.culled = 0;

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Thinking Break: program link failed — ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;

    this.uniforms = {
      viewProj: gl.getUniformLocation(program, 'u_viewProj'),
      eye: gl.getUniformLocation(program, 'u_eye'),
      lightDir: gl.getUniformLocation(program, 'u_lightDir'),
      fogColor: gl.getUniformLocation(program, 'u_fogColor'),
      fogRange: gl.getUniformLocation(program, 'u_fogRange'),
      exposure: gl.getUniformLocation(program, 'u_exposure'),
    };

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    const cubeBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buildCube(), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);

    this.instanceData = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
    this.instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_INSTANCE * 4;
    const attrib = (loc, size, offset) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attrib(2, 3, 0);   // centre
    attrib(3, 3, 12);  // half-extents
    attrib(4, 3, 24);  // colour
    attrib(5, 1, 36);  // yaw

    gl.bindVertexArray(null);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);

    this.proj = new Float32Array(16);
    this.view = new Float32Array(16);
    this.viewProj = new Float32Array(16);
    this.frustum = new Float32Array(24);
    this.count = 0;
  }

  /** Resize the drawing buffer to the CSS size × render scale. */
  resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, this.pixelRatioCap);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr * this.renderScale));
    const h = Math.max(1, Math.round(rect.height * dpr * this.renderScale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { width: w, height: h, aspect: w / Math.max(1, h) };
  }

  /** Begin a frame: set up matrices, clear, and reset the instance stream. */
  begin({ eye, yaw, pitch, fovDeg, near = 0.08, far = 260, fogColor, fogRange, exposure = 1 }) {
    const gl = this.gl;
    const { width, height, aspect } = this.resize();
    gl.viewport(0, 0, width, height);

    mat4Perspective(this.proj, (fovDeg * Math.PI) / 180, aspect, near, far);
    mat4View(this.view, eye, yaw, pitch);
    mat4Multiply(this.viewProj, this.proj, this.view);
    frustumFromViewProj(this.viewProj, this.frustum);

    gl.clearColor(fogColor[0], fogColor[1], fogColor[2], 1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.count = 0;
    this.culled = 0;
    this.drawnInstances = 0;
    this._frame = { eye, fogColor, fogRange, exposure };
  }

  /** Queue a box. Returns false when it was culled or the buffer is full. */
  push(x, y, z, hx, hy, hz, r, g, b, yaw = 0, cull = true) {
    if (this.count >= MAX_INSTANCES) return false;
    if (cull) {
      const radius = Math.hypot(hx, hy, hz);
      if (!sphereInFrustum(this.frustum, x, y, z, radius)) { this.culled++; return false; }
    }
    const i = this.count * FLOATS_PER_INSTANCE;
    const d = this.instanceData;
    d[i] = x; d[i + 1] = y; d[i + 2] = z;
    d[i + 3] = hx; d[i + 4] = hy; d[i + 5] = hz;
    d[i + 6] = r; d[i + 7] = g; d[i + 8] = b;
    d[i + 9] = yaw;
    this.count++;
    return true;
  }

  /** Convenience for arena/pickup objects that already carry `color`. */
  pushBox(box, color = box.color, yaw = 0) {
    return this.push(box.x, box.y, box.z, box.hx, box.hy, box.hz, color[0], color[1], color[2], yaw);
  }

  /** Flush everything queued since `begin`/the last flush. */
  flush() {
    const gl = this.gl;
    if (this.count === 0) return;
    const { eye, fogColor, fogRange, exposure } = this._frame;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData, 0, this.count * FLOATS_PER_INSTANCE);

    gl.uniformMatrix4fv(this.uniforms.viewProj, false, this.viewProj);
    gl.uniform3f(this.uniforms.eye, eye[0], eye[1], eye[2]);
    gl.uniform3f(this.uniforms.lightDir, 0.42, 0.82, 0.39);
    gl.uniform3f(this.uniforms.fogColor, fogColor[0], fogColor[1], fogColor[2]);
    gl.uniform2f(this.uniforms.fogRange, fogRange[0], fogRange[1]);
    gl.uniform1f(this.uniforms.exposure, exposure);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.count);
    // Accumulated across the world and viewmodel passes, so the debug readout
    // reflects the whole frame rather than whichever pass flushed last.
    this.drawnInstances += this.count;
    this.count = 0;
  }

  /**
   * Switch to the first-person viewmodel pass: depth is cleared so the weapon
   * never intersects the world, and a narrow FOV keeps it from fish-eyeing.
   */
  beginViewmodel(fovDeg = 55) {
    const gl = this.gl;
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    mat4Perspective(this.proj, (fovDeg * Math.PI) / 180, aspect, 0.01, 8);
    mat4View(this.view, [0, 0, 0], 0, 0);
    mat4Multiply(this.viewProj, this.proj, this.view);
    // Viewmodel boxes are hand-placed in front of the camera — culling them
    // against the world frustum would be both wrong and pointless.
    this._frame = { ...this._frame, fogRange: [0, 0] };
  }

  /** Push a viewmodel box in camera space (never culled). */
  pushView(x, y, z, hx, hy, hz, r, g, b, yaw = 0) {
    return this.push(x, y, z, hx, hy, hz, r, g, b, yaw, false);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
  }
}
