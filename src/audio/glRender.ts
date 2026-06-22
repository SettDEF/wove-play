import { program, makeTarget, resizeTarget, hex3, type Target } from "@/gl/glcore";
import { analyzeField, smoothBuckets, buildTransforms, bindAdd, frameDt, pruneMem, applyHue, getDrawable, textContent, type VizBuffers, type Mat, type AudioField } from "./vizRender";
import type { Scene, PropValue } from "@/store/viz";

// ── shaders (GLSL ES 3.00) ───────────────────────────────────────────────────
const V = "#version 300 es\n";
const F = "#version 300 es\nprecision highp float;\n";

const SCENE_VS = V + `
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_color;
layout(location=2) in float a_size;
out vec4 v_color;
void main(){ v_color = a_color; gl_PointSize = a_size; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const SCENE_FS = F + `
in vec4 v_color; uniform float u_alpha; uniform float u_round; out vec4 o;
void main(){
  if (u_round > 0.5){ vec2 d = gl_PointCoord - vec2(0.5); if (dot(d,d) > 0.25) discard; }
  o = vec4(v_color.rgb, v_color.a * u_alpha);
}`;

const POST_VS = V + `
layout(location=0) in vec2 a_pos; out vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const BRIGHT_FS = F + `
in vec2 v_uv; uniform sampler2D u_tex; uniform float u_thresh; out vec4 o;
void main(){ vec3 c = texture(u_tex, v_uv).rgb; float l = dot(c, vec3(0.299,0.587,0.114));
  float k = max(0.0, l - u_thresh) / max(l, 1e-4); o = vec4(c * k, 1.0); }`;
const BLUR_FS = F + `
in vec2 v_uv; uniform sampler2D u_tex; uniform vec2 u_dir; out vec4 o;
void main(){
  vec3 s = texture(u_tex, v_uv).rgb * 0.2270270270;
  s += texture(u_tex, v_uv + u_dir * 1.3846153846).rgb * 0.3162162162;
  s += texture(u_tex, v_uv - u_dir * 1.3846153846).rgb * 0.3162162162;
  s += texture(u_tex, v_uv + u_dir * 3.2307692308).rgb * 0.0702702703;
  s += texture(u_tex, v_uv - u_dir * 3.2307692308).rgb * 0.0702702703;
  o = vec4(s, 1.0);
}`;
const COMP_FS = F + `
in vec2 v_uv; uniform sampler2D u_scene; uniform sampler2D u_bloom; uniform float u_intensity; out vec4 o;
void main(){ vec3 s = texture(u_scene, v_uv).rgb; vec3 b = texture(u_bloom, v_uv).rgb;
  o = vec4(s + b * u_intensity, 1.0); }`;

// textured quad (image + rasterized text)
const TEX_VS = V + `
layout(location=0) in vec2 a_pos; layout(location=1) in vec2 a_uv; out vec2 v_uv;
void main(){ v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const TEX_FS = F + `
in vec2 v_uv; uniform sampler2D u_tex; uniform float u_alpha; uniform float u_circle; out vec4 o;
void main(){
  if (u_circle > 0.5) { vec2 d = v_uv - vec2(0.5); if (dot(d, d) > 0.25) discard; }
  vec4 c = texture(u_tex, v_uv); o = vec4(c.rgb, c.a * u_alpha);
}`;

function texFromSource(gl: WebGL2RenderingContext, src: TexImageSource): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
function rasterShape(wp: Record<string, PropValue>, bw: number, bh: number): { canvas: HTMLCanvasElement; w: number; h: number } {
  const fill = Bl(wp, "fill", false), stroke = Math.max(1, N(wp, "stroke", 6));
  const pad = Math.ceil(stroke + 4);
  const W = Math.max(2, Math.ceil(bw + pad * 2)), H = Math.max(2, Math.ceil(bh + pad * 2));
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d")!;
  let style: string | CanvasGradient = Sg(wp, "color1", "#fff");
  if (Bl(wp, "useGradient")) { const g = ctx.createLinearGradient(0, H, 0, 0); g.addColorStop(0, Sg(wp, "color1", "#fff")); g.addColorStop(1, Sg(wp, "color2", "#fff")); style = g; }
  ctx.fillStyle = style; ctx.strokeStyle = style; ctx.lineWidth = stroke;
  if (Sg(wp, "shape", "rect") === "circle") {
    const r = Math.min(bw, bh) / 2; ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
  } else {
    const r = N(wp, "radius", 0.12) * Math.min(bw, bh);
    const rr = Math.max(0, Math.min(r, bw / 2, bh / 2));
    ctx.beginPath(); ctx.moveTo(pad + rr, pad);
    ctx.arcTo(pad + bw, pad, pad + bw, pad + bh, rr); ctx.arcTo(pad + bw, pad + bh, pad, pad + bh, rr);
    ctx.arcTo(pad, pad + bh, pad, pad, rr); ctx.arcTo(pad, pad, pad + bw, pad, rr); ctx.closePath();
  }
  if (fill) ctx.fill(); else ctx.stroke();
  return { canvas: c, w: W, h: H };
}
function rasterText(content: string, size: number, color: string): { canvas: HTMLCanvasElement; w: number; h: number } {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = `800 ${Math.round(size)}px Montserrat, Roboto, system-ui, sans-serif`;
  ctx.font = font;
  const tw = Math.ceil(ctx.measureText(content).width);
  const pad = Math.ceil(size * 0.35);
  const w = Math.max(2, tw + pad * 2), h = Math.max(2, Math.ceil(size * 1.5));
  c.width = w; c.height = h;
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(content, w / 2, h / 2);
  return { canvas: c, w, h };
}

// ── prop accessors ────────────────────────────────────────────────────────────
const N = (o: Record<string, PropValue>, k: string, d = 0) => (typeof o[k] === "number" ? (o[k] as number) : d);
const Sg = (o: Record<string, PropValue>, k: string, d = "") => (typeof o[k] === "string" ? (o[k] as string) : d);
const Bl = (o: Record<string, PropValue>, k: string, d = false) => (typeof o[k] === "boolean" ? (o[k] as boolean) : d);

interface GLParticle { x: number; y: number; vx: number; vy: number; size: number; life: number; }

/** GPU visualiser renderer: builds layer geometry per frame, shades + composites with a real
 *  bloom post-process. Same scene model as the Canvas2D path; throws if WebGL2 is unavailable. */
export class GLRenderer {
  readonly isGL = true;
  private gl: WebGL2RenderingContext;
  private pScene: WebGLProgram;
  private pBright: WebGLProgram;
  private pBlur: WebGLProgram;
  private pComp: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private quadVao: WebGLVertexArrayObject;
  private pTex: WebGLProgram;
  private texVao: WebGLVertexArrayObject;
  private texVbo: WebGLBuffer;
  private imageTex = new Map<string, WebGLTexture>();
  private textTex = new Map<string, { key: string; tex: WebGLTexture; w: number; h: number }>();
  private scene: Target | null = null;
  private bloomA: Target | null = null;
  private bloomB: Target | null = null;
  private particles = new Map<string, GLParticle[]>();
  private smooth = new Map<string, { sm?: Float32Array }>();
  private bindMem = new Map<string, number>();
  private bloomIntensity = 1.1;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.pScene = program(gl, SCENE_VS, SCENE_FS);
    this.pBright = program(gl, POST_VS, BRIGHT_FS);
    this.pBlur = program(gl, POST_VS, BLUR_FS);
    this.pComp = program(gl, POST_VS, COMP_FS);

    // dynamic scene geometry buffer + VAO (loc 0 pos, 1 color, 2 size) stride 28 bytes
    this.vbo = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);

    // fullscreen quad for post passes
    const quad = gl.createBuffer()!;
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // textured-quad program + VAO (loc 0 pos vec2, loc 1 uv vec2) stride 16
    this.pTex = program(gl, TEX_VS, TEX_FS);
    this.texVbo = gl.createBuffer()!;
    this.texVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.texVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
  }

  setBloom(v: number) { this.bloomIntensity = v; }

  private ensureTargets(pw: number, ph: number) {
    const gl = this.gl;
    const bw = Math.max(1, pw >> 1), bh = Math.max(1, ph >> 1);
    if (!this.scene) { this.scene = makeTarget(gl, pw, ph); this.bloomA = makeTarget(gl, bw, bh); this.bloomB = makeTarget(gl, bw, bh); }
    else { resizeTarget(gl, this.scene, pw, ph); resizeTarget(gl, this.bloomA!, bw, bh); resizeTarget(gl, this.bloomB!, bw, bh); }
  }

  render(pw: number, ph: number, scene: Scene, analyser: AnalyserNode | null, buf: VizBuffers, text?: { title: string; artist: string; lyric?: string }) {
    const gl = this.gl;
    this.ensureTargets(pw, ph);
    const dt = frameDt(this.bindMem);
    pruneMem(this.bindMem, scene);
    const field = analyzeField(analyser, buf);
    const world = buildTransforms(scene, pw, ph, field, this.bindMem, dt);

    // 1) render the scene into the HDR target
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene!.fbo);
    gl.viewport(0, 0, pw, ph);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.useProgram(this.pScene);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); // VAO restores attrib pointers but NOT the ARRAY_BUFFER binding
    const uAlpha = gl.getUniformLocation(this.pScene, "u_alpha");
    const uRound = gl.getUniformLocation(this.pScene, "u_round");

    for (const layer of scene.layers) {
      if (layer.type === "group") continue; // composite node: transform only
      const wt = world.get(layer.id);
      if (!wt || !wt.visible) continue;
      // leaf prop bindings (transform binds already applied in buildTransforms)
      const wp: Record<string, PropValue> = { ...layer.props };
      for (const key in layer.bind) {
        if (key === "x" || key === "y" || key === "scale" || key === "rotation" || key === "opacity") continue;
        const cur = wp[key];
        if (typeof cur === "number") wp[key] = cur + bindAdd(field, layer.bind[key], this.bindMem, `${layer.id}:${key}`, dt);
        else if (key === "hue") wp[key] = bindAdd(field, layer.bind[key], this.bindMem, `${layer.id}:${key}`, dt);
      }
      applyHue(wp); // P3 color reactivity

      // blend mode
      if (layer.blend === "lighter" || layer.blend === "screen") gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else if (layer.blend === "multiply") gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      // textured leaves (image / text / shape) use their own program, then we restore the geometry program
      if (layer.type === "image" || layer.type === "text" || layer.type === "shape") {
        this.drawTextured(layer, wp, wt.op, wt.m, pw, ph, text);
        gl.useProgram(this.pScene); gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        continue;
      }
      gl.uniform1f(uAlpha, wt.op);

      const tf = layer.type === "background" ? tfIdent(pw, ph) : tfMat(wt.m, pw, ph);
      const glow = N(wp, "glow", 0);
      const c1 = hex3(Sg(wp, "color1", "#ffffff"));
      const c2 = Bl(wp, "useGradient") ? hex3(Sg(wp, "color2", "#ffffff")) : c1;
      const emis = 1 + glow / 26;
      const colAt = (py: number): [number, number, number, number] => {
        const f = 1 - py / ph;
        return [(c1[0] + (c2[0] - c1[0]) * f) * emis, (c1[1] + (c2[1] - c1[1]) * f) * emis, (c1[2] + (c2[2] - c1[2]) * f) * emis, 1];
      };

      const data: number[] = [];
      let prim: number = gl.TRIANGLES, round = 0;
      switch (layer.type) {
        case "background": buildBackground(data, pw, ph, c1, c2, Bl(wp, "useGradient")); break;
        case "spectrum": prim = buildSpectrum(data, pw, ph, wp, field, dt, this.sstate(layer.id), tf, colAt) ?? gl.TRIANGLES; break;
        case "wave": prim = gl.LINE_STRIP; buildWave(data, pw, ph, wp, analyser, buf, tf, colAt); break;
        case "radial": prim = gl.LINES; buildRadial(data, pw, ph, wp, field, dt, this.sstate(layer.id), tf, colAt); break;
        case "particles": prim = gl.POINTS; round = 1; buildParticles(data, pw, ph, wp, field.bands, this.pstate(layer.id), tf, c1, c2, emis); break;
      }
      if (!data.length) continue;
      gl.uniform1f(uRound, round);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      gl.drawArrays(prim, 0, data.length / 7);
    }

    // 2) bloom: bright-pass → blur (H,V) → composite to screen
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.quadVao);
    const bw = this.bloomA!.w, bh = this.bloomA!.h;

    gl.useProgram(this.pBright);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA!.fbo); gl.viewport(0, 0, bw, bh);
    gl.uniform1f(gl.getUniformLocation(this.pBright, "u_thresh"), 0.62);
    bindTex(gl, this.pBright, "u_tex", this.scene!.tex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.useProgram(this.pBlur);
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB!.fbo); gl.viewport(0, 0, bw, bh);
      gl.uniform2f(gl.getUniformLocation(this.pBlur, "u_dir"), 1 / bw, 0);
      bindTex(gl, this.pBlur, "u_tex", this.bloomA!.tex, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA!.fbo); gl.viewport(0, 0, bw, bh);
      gl.uniform2f(gl.getUniformLocation(this.pBlur, "u_dir"), 0, 1 / bh);
      bindTex(gl, this.pBlur, "u_tex", this.bloomB!.tex, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.useProgram(this.pComp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, pw, ph);
    gl.uniform1f(gl.getUniformLocation(this.pComp, "u_intensity"), this.bloomIntensity);
    bindTex(gl, this.pComp, "u_scene", this.scene!.tex, 0);
    bindTex(gl, this.pComp, "u_bloom", this.bloomA!.tex, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private pstate(id: string): GLParticle[] { let s = this.particles.get(id); if (!s) { s = []; this.particles.set(id, s); } return s; }
  private sstate(id: string): { sm?: Float32Array } { let s = this.smooth.get(id); if (!s) { s = {}; this.smooth.set(id, s); } return s; }

  /** Draw an image or rasterized-text layer as a textured quad (world-transformed). */
  private drawTextured(layer: { id: string; type: string }, wp: Record<string, PropValue>, alpha: number, m: Mat, pw: number, ph: number, text?: { title: string; artist: string; lyric?: string }) {
    const gl = this.gl;
    let tex: WebGLTexture | undefined;
    let dx = 0, dy = 0, dw = pw, dh = ph;
    let circle = 0;
    if (layer.type === "image") {
      const src = Sg(wp, "src", "");
      const d = getDrawable(src);
      if (!d) return;
      tex = this.imageTex.get(src);
      if (!tex) { tex = texFromSource(gl, d.source); this.imageTex.set(src, tex); }
      if (Bl(wp, "circle", false)) {
        const sq = Math.min(pw, ph); dw = dh = sq; dx = (pw - sq) / 2; dy = (ph - sq) / 2; circle = 1;
      } else {
        const fit = Sg(wp, "fit", "cover");
        if (fit !== "fill") {
          const sc = fit === "contain" ? Math.min(pw / d.w, ph / d.h) : Math.max(pw / d.w, ph / d.h);
          dw = d.w * sc; dh = d.h * sc; dx = (pw - dw) / 2; dy = (ph - dh) / 2;
        }
      }
    } else if (layer.type === "shape") {
      const bw = Math.max(2, N(wp, "w", 0.5) * pw), bh = Math.max(2, N(wp, "h", 0.3) * ph);
      const key = `shape|${Sg(wp, "shape", "rect")}|${Math.round(bw)}|${Math.round(bh)}|${N(wp, "stroke", 6)}|${N(wp, "radius", 0.12)}|${Bl(wp, "fill", false)}|${Sg(wp, "color1", "")}|${Sg(wp, "color2", "")}|${Bl(wp, "useGradient", false)}`;
      let rec = this.textTex.get(layer.id);
      if (!rec || rec.key !== key) {
        if (rec) gl.deleteTexture(rec.tex);
        const r = rasterShape(wp, bw, bh);
        rec = { key, tex: texFromSource(gl, r.canvas), w: r.w, h: r.h };
        this.textTex.set(layer.id, rec);
      }
      tex = rec.tex; dw = rec.w; dh = rec.h; dx = (pw - dw) / 2; dy = (ph - dh) / 2;
    } else {
      const content = textContent(wp, text);
      if (!content) return;
      const size = Math.max(6, N(wp, "size", 0.09) * ph);
      const color = Sg(wp, "color1", "#ffffff");
      const key = `${content}|${Math.round(size)}|${color}`;
      let rec = this.textTex.get(layer.id);
      if (!rec || rec.key !== key) {
        if (rec) gl.deleteTexture(rec.tex);
        const r = rasterText(content, size, color);
        rec = { key, tex: texFromSource(gl, r.canvas), w: r.w, h: r.h };
        this.textTex.set(layer.id, rec);
      }
      tex = rec.tex; dw = rec.w; dh = rec.h; dx = (pw - dw) / 2; dy = (ph - dh) / 2;
    }
    if (!tex) return;
    const tf = tfMat(m, pw, ph);
    const TL = tf(dx, dy), TR = tf(dx + dw, dy), BL = tf(dx, dy + dh), BR = tf(dx + dw, dy + dh);
    gl.useProgram(this.pTex);
    gl.bindVertexArray(this.texVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([TL[0], TL[1], 0, 0, TR[0], TR[1], 1, 0, BL[0], BL[1], 0, 1, BR[0], BR[1], 1, 1]), gl.DYNAMIC_DRAW);
    gl.uniform1f(gl.getUniformLocation(this.pTex, "u_alpha"), alpha);
    gl.uniform1f(gl.getUniformLocation(this.pTex, "u_circle"), circle);
    bindTex(gl, this.pTex, "u_tex", tex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.pScene); gl.deleteProgram(this.pBright); gl.deleteProgram(this.pBlur); gl.deleteProgram(this.pComp); gl.deleteProgram(this.pTex);
    gl.deleteBuffer(this.vbo); gl.deleteBuffer(this.texVbo);
    gl.deleteVertexArray(this.vao); gl.deleteVertexArray(this.quadVao); gl.deleteVertexArray(this.texVao);
    for (const t of this.imageTex.values()) gl.deleteTexture(t);
    for (const r of this.textTex.values()) gl.deleteTexture(r.tex);
    this.imageTex.clear(); this.textTex.clear();
    // free the render targets (FBO + texture) — otherwise GPU memory leaks across remounts
    for (const t of [this.scene, this.bloomA, this.bloomB]) { if (t) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); } }
    this.scene = this.bloomA = this.bloomB = null;
  }
}

function bindTex(gl: WebGL2RenderingContext, p: WebGLProgram, name: string, tex: WebGLTexture, unit: number) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(p, name), unit);
}

// ── transform: pixel-space (px,py) → clip-space ────────────────────────────────────
type Tf = (px: number, py: number) => [number, number];
const tfIdent = (w: number, h: number): Tf => (px, py) => [(px / w) * 2 - 1, 1 - (py / h) * 2];
/** Apply a composed world matrix [a,b,c,d,e,f] (pixel→pixel) then convert to clip space. */
function tfMat(m: Mat, w: number, h: number): Tf {
  return (px, py) => {
    const X = m[0] * px + m[2] * py + m[4], Y = m[1] * px + m[3] * py + m[5];
    return [(X / w) * 2 - 1, 1 - (Y / h) * 2];
  };
}

type ColAt = (py: number) => [number, number, number, number];
function push(data: number[], p: [number, number], col: [number, number, number, number], size = 1) {
  data.push(p[0], p[1], col[0], col[1], col[2], col[3], size);
}
function rect(data: number[], tf: Tf, x: number, yTop: number, w: number, yBot: number, colAt: ColAt) {
  const ct = colAt(yTop), cb = colAt(yBot);
  const a = tf(x, yTop), b = tf(x + w, yTop), c = tf(x + w, yBot), d = tf(x, yBot);
  push(data, a, ct); push(data, b, ct); push(data, c, cb);
  push(data, a, ct); push(data, c, cb); push(data, d, cb);
}

function buildBackground(data: number[], _w: number, _h: number, c1: [number, number, number], c2: [number, number, number], grad: boolean) {
  const bottom: [number, number, number, number] = [c1[0], c1[1], c1[2], 1];
  const top: [number, number, number, number] = grad ? [c2[0], c2[1], c2[2], 1] : bottom;
  const tl = [-1, 1] as [number, number], tr = [1, 1] as [number, number], bl = [-1, -1] as [number, number], br = [1, -1] as [number, number];
  push(data, bl, bottom); push(data, br, bottom); push(data, tr, top);
  push(data, bl, bottom); push(data, tr, top); push(data, tl, top);
}

function buildSpectrum(data: number[], w: number, h: number, wp: Record<string, PropValue>, field: AudioField, dt: number, st: { sm?: Float32Array }, tf: Tf, colAt: ColAt): number | null {
  const n = Math.max(2, Math.round(N(wp, "count", 64)));
  const mags = smoothBuckets(field, n, N(wp, "sensitivity", 1.3), N(wp, "smoothing", 0.78), dt, st, Bl(wp, "logFreq", false));
  const style = Sg(wp, "style", "bars");
  const gap = N(wp, "gap", 2);
  const anchor = Sg(wp, "anchor", "bottom");
  const yTop = (bh: number) => anchor === "top" ? 0 : anchor === "center" ? h / 2 - bh / 2 : h - bh;
  const yBot = (bh: number) => anchor === "top" ? bh : anchor === "center" ? h / 2 + bh / 2 : h;

  if (style === "mirror") {
    const half = Math.max(1, Math.floor(n / 2)); const bw = (w / 2 - gap * half) / half;
    for (let i = 0; i < half; i++) { const bh = Math.max(2, mags[i] * mags[i] * h); rect(data, tf, w / 2 + i * (bw + gap), yTop(bh), bw, yBot(bh), colAt); rect(data, tf, w / 2 - (i + 1) * (bw + gap), yTop(bh), bw, yBot(bh), colAt); }
    return WebGL2RenderingContext.TRIANGLES;
  }
  const bw = (w - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) { const bh = Math.max(2, mags[i] * mags[i] * h); rect(data, tf, i * (bw + gap), yTop(bh), bw, yBot(bh), colAt); }
  return WebGL2RenderingContext.TRIANGLES;
}

function buildWave(data: number[], w: number, h: number, wp: Record<string, PropValue>, an: AnalyserNode | null, buf: VizBuffers, tf: Tf, colAt: ColAt) {
  if (!an) return;
  an.getByteTimeDomainData(buf.time);
  const n = buf.time.length, amp = N(wp, "sensitivity", 1);
  for (let i = 0; i < n; i += 2) {
    const x = (i / n) * w; const y = h / 2 + ((buf.time[i] - 128) / 128) * (h / 2) * amp;
    push(data, tf(x, y), colAt(y));
  }
}

function buildRadial(data: number[], w: number, h: number, wp: Record<string, PropValue>, field: AudioField, dt: number, st: { sm?: Float32Array }, tf: Tf, colAt: ColAt) {
  const n = Math.max(2, Math.round(N(wp, "count", 96)));
  const mags = smoothBuckets(field, n, N(wp, "sensitivity", 1.3), N(wp, "smoothing", 0.8), dt, st, Bl(wp, "logFreq", false));
  const cx = w / 2, cy = h / 2, radius = Math.min(w, h) * N(wp, "radius", 0.22);
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const len = radius + mags[i] * mags[i] * Math.min(w, h) * 0.3;
    const c = Math.cos(ang), s = Math.sin(ang);
    push(data, tf(cx + c * radius, cy + s * radius), colAt(cy));
    push(data, tf(cx + c * len, cy + s * len), colAt(cy - len));
  }
}

function buildParticles(data: number[], w: number, h: number, wp: Record<string, PropValue>, bands: { bass: number }, st: GLParticle[], tf: Tf, c1: [number, number, number], c2: [number, number, number], emis: number) {
  const sens = N(wp, "sensitivity", 1.4), cap = Math.max(10, Math.round(N(wp, "count", 220)));
  const baseSize = N(wp, "size", 3), gravity = N(wp, "gravity", 1), spread = N(wp, "spread", 1);
  const center = Sg(wp, "origin", "bottom") === "center";
  const energy = bands.bass * sens, spawn = Math.floor(energy * 6);
  for (let i = 0; i < spawn && st.length < cap; i++) {
    if (center) {
      const a = Math.random() * Math.PI * 2, spd = (1.5 + energy * 5) * (0.5 + spread);
      st.push({ x: w / 2, y: h / 2, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, size: baseSize * (0.5 + Math.random()), life: 1 });
    } else {
      st.push({ x: Math.random() * w, y: h + 4, vx: (Math.random() - 0.5) * spread * 2, vy: -(1 + energy * 6 + Math.random() * 2), size: baseSize * (0.5 + Math.random()), life: 1 });
    }
  }
  for (const p of st) {
    p.x += p.vx; p.y += p.vy; if (!center) p.vy += gravity * 0.02; p.life -= 0.006;
    const col: [number, number, number, number] = [c1[0] * emis, c1[1] * emis, c1[2] * emis, Math.max(0, p.life)];
    void c2;
    push(data, tf(p.x, p.y), col, Math.max(1, p.size * 2));
  }
  const alive = st.filter((p) => p.life > 0);
  st.length = 0; st.push(...alive);
}
