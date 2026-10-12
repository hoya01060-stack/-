// 모바일 화면 E2E 점검. `npm run build` 후 실행한다.
// 사용법: node e2e/run.mjs  (PORT, CHROMIUM_PATH 환경변수로 바꿀 수 있음)
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT || 3123);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(import.meta.dirname, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const candidates = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium",
].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));

let failures = 0;
const results = [];
function check(name, cond, detail = "") {
  results.push(`${cond ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

// 키 없이 실행해 데모 모드를 확인한다.
const env = { ...process.env, ANTHROPIC_API_KEY: "", AI_PROVIDER: "anthropic", PORT: String(PORT), RATE_LIMIT_MAX: "50" };
// 포트가 이미 쓰이고 있으면(이전 실행의 서버가 남아 있으면) 다른 빌드를 검사하게 되므로 중단한다.
try {
  await fetch(`${BASE}/api/config`);
  console.error(`포트 ${PORT}에서 이미 서버가 실행 중입니다. 종료한 뒤 다시 실행하세요.`);
  process.exit(2);
} catch {}
const nextBin = path.join(import.meta.dirname, "..", "node_modules", "next", "dist", "bin", "next");
// 별도 프로세스 그룹으로 띄워, 끝날 때 next-server 자식까지 함께 종료한다.
const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT), "-H", "127.0.0.1"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
const stopServer = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stopServer);
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const browser = await chromium.launch({ executablePath, headless: true });
try {
  await waitForServer();
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "ko-KR",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  let analyzeCalls = 0;
  let analyzeBodies = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/analyze")) {
      analyzeCalls++;
      analyzeBodies.push(r.postData() || "");
    }
  });

  const noHScroll = async (label) => {
    const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check(`가로 스크롤 없음: ${label}`, ok);
  };
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

  // ── 홈 ─────────────────────────────
  await page.goto(BASE);
  await page.getByRole("heading", { name: "이 말, 어떻게 받아들여야 할까요?" }).waitFor();
  check("첫 화면 제목", true);
  check("첫 화면 설명 문구", await page.getByText("대화 속 근거와 가능한 해석을 살펴보고, 나에게 맞는 다음 말을 찾아보세요.").isVisible());
  await page.getByText("데모 모드", { exact: false }).first().waitFor();
  check("API 키 없음 → 데모 모드 표시", await page.locator(".tag-demo").isVisible());
  await noHScroll("홈");
  await shot("01-home");

  // 키보드로 시작하기
  await page.getByRole("button", { name: "시작하기" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "어떤 관계의 대화인가요?" }).waitFor();
  check("키보드(Enter)로 시작", true);
  const focusedIsHeading = await page.evaluate(() => document.activeElement?.tagName === "H2");
  check("단계 전환 시 제목으로 포커스 이동", focusedIsHeading);

  // ── 관계·목표 ───────────────────────
  await page.getByLabel("직장").check();
  // 화살표 키로 라디오 이동
  await page.getByLabel("표현 이해").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  check("화살표 키로 목표 선택", await page.getByLabel("답장 작성").isChecked());
  await page.getByLabel("경계 설정").check();
  await noHScroll("관계·목표");
  await shot("02-setup");
  await page.getByRole("button", { name: "다음" }).click();

  // ── 입력 ────────────────────────────
  await page.getByRole("heading", { name: "상황과 대화를 알려 주세요" }).waitFor();
  check("입력 단계 개인정보 안내", await page.getByText("자동 가림은 일부를 놓칠 수 있으니", { exact: false }).isVisible());
  await page.getByLabel("가상 사례").selectOption("work");
  await page.getByRole("button", { name: "가상 사례 대화 넣기" }).click();
  // 개인정보 가림 확인용 문장을 덧붙인다.
  const conv = page.locator("textarea.tall");
  await conv.fill((await conv.inputValue()) + "\n상대: 급하면 010-1234-5678로 전화 주세요");
  await noHScroll("입력");
  await shot("03-input");
  await page.getByRole("button", { name: "발화자 확인하기" }).click();

  // ── 발화자 ──────────────────────────
  await page.getByRole("heading", { name: "누가 한 말인지 확인해 주세요" }).waitFor();
  const meChecked = await page.locator('input[name="sp-나"][value="me"]').isChecked();
  const otherChecked = await page.locator('input[name="sp-상대"][value="other"]').isChecked();
  check("발화자 자동 추정(나/상대)", meChecked && otherChecked);
  await noHScroll("발화자");
  await shot("04-speakers");
  await page.getByRole("button", { name: "전송 내용 확인하기" }).click();

  // ── 미리보기 ────────────────────────
  await page.getByRole("heading", { name: "전송될 내용을 확인해 주세요" }).waitFor();
  check("전화번호 가림 미리보기", await page.locator(".preview-box mark", { hasText: "[전화번호]" }).isVisible());
  check("미리보기에 원래 번호 없음", !(await page.locator(".preview-box").innerText()).includes("010-1234-5678"));
  check("데모 모드 미전송 안내", await page.getByText("서버로 전송되지 않습니다", { exact: false }).isVisible());
  await page.getByRole("button", { name: "맥락 질문으로" }).click();
  check("확인 체크 없이 진행 차단", await page.getByRole("alert").filter({ hasText: "체크해 주세요" }).isVisible());
  await page.getByLabel("전송될 내용을 확인했고", { exact: false }).check();
  await noHScroll("미리보기");
  await shot("05-preview");
  await page.getByRole("button", { name: "맥락 질문으로" }).click();

  // ── 맥락 질문 + 오류 처리 ────────────
  await page.getByRole("heading", { name: "조금 더 알려 주시겠어요?" }).waitFor();
  await page.getByLabel("평소와 다름").check();
  await page.getByLabel("상대가 더 큰 영향력을 가짐").check();
  await page.getByLabel("담백하게").check();
  await noHScroll("맥락 질문");
  await shot("06-context");

  // 첫 요청은 서버 오류로 만든다 → 오류 표시 + 입력 유지
  let failOnce = true;
  await page.route("**/api/analyze", async (route) => {
    if (failOnce) {
      failOnce = false;
      await new Promise((r) => setTimeout(r, 300));
      return route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "AI_UNAVAILABLE", message: "AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." } }),
      });
    }
    return route.continue();
  });
  const analyzeBtn = page.getByRole("button", { name: "가상 사례 결과 보기" });
  // 중복 제출: 빠르게 여러 번 누른다
  await analyzeBtn.click();
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("분석 중") || x.textContent?.includes("가상 사례 결과 보기"));
    b?.click();
    b?.click();
  });
  await page.getByRole("alert").filter({ hasText: "AI 서비스에 연결하지 못했습니다" }).waitFor();
  check("API 오류 메시지 표시", true);
  check("연타해도 요청 1회", analyzeCalls === 1, `요청 수 ${analyzeCalls}`);
  check("오류 후 맥락 답변 유지", await page.getByLabel("평소와 다름").isChecked());
  await shot("07-error");

  await page.getByRole("button", { name: "다시 시도하기" }).click();
  await page.getByRole("heading", { name: "대화에서 살펴본 내용이에요" }).waitFor();
  check("재시도 후 결과 표시", true);
  check("데모 모드 요청에 사용자 대화 미포함", !analyzeBodies.some((b) => b.includes("010-1234-5678") || b.includes("회의 자료")));

  // ── 결과 ────────────────────────────
  check("데모 결과 표시", await page.locator(".tag-demo", { hasText: "데모 결과" }).isVisible());
  check("‘입력하신 대화를 분석한 것이 아닙니다’ 안내", await page.getByText("입력하신 대화를 분석한 것이 아닙니다").isVisible());
  for (const h of ["관찰된 내용", "원문 근거", "가능한 해석", "확인되지 않은 부분", "추가로 확인해 볼 질문", "대응 선택지", "답장 예시"]) {
    check(`결과 섹션: ${h}`, await page.getByRole("heading", { name: h }).isVisible());
  }
  check("반대 근거·한계 표시", (await page.getByText("반대 근거 · 한계").count()) >= 2);
  check("가짜 인용 제외 안내", await page.getByText("원문에서 찾을 수 없는 인용 1개", { exact: false }).isVisible());
  check("가짜 인용 미표시", !(await page.locator("main").innerText()).includes("이렇게밖에 못하나요"));
  check("답장: 반응 예측 아님 표시", await page.getByText("상대가 실제로 어떻게 반응할지 예측한 것이 아니며").isVisible());
  await noHScroll("결과");
  await shot("08-result");

  // 답장 수정·복사
  const replyBox = page.getByLabel("답장 다듬기");
  check("선택한 말투(담백하게) 답장", (await replyBox.inputValue()).includes("오전 10시"));
  await replyBox.fill("내일 오전에 드리겠습니다.");
  await page.getByRole("button", { name: "복사하기" }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("수정한 답장 복사", clip === "내일 오전에 드리겠습니다.");
  await page.locator('input[name="tone-result"][value="firm"]').check();
  await page.getByRole("button", { name: "이 말투로 다시 만들기" }).click();
  await page.getByText("새 답장 예시를 만들었어요.").waitFor();
  check("말투 바꿔 답장 재생성", (await replyBox.inputValue()).includes("업무시간"));

  // 신고
  await page.getByRole("button", { name: "결과 신고하기" }).click();
  await page.getByLabel("한쪽 편만 듦").check();
  await page.getByRole("button", { name: "신고 보내기" }).click();
  await page.getByRole("button", { name: "신고해 주셔서 감사합니다" }).waitFor();
  check("결과 신고", true);

  // ── 저장소 미사용 확인 ───────────────
  const storage = await page.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, cookie: document.cookie }));
  check("localStorage·sessionStorage·쿠키 비어 있음", storage.ls === 0 && storage.ss === 0 && storage.cookie === "", JSON.stringify(storage));

  // ── 기록 삭제 ───────────────────────
  await page.getByRole("button", { name: "기록 삭제", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await shot("09-reset-dialog");
  await page.getByRole("button", { name: "모두 지우기" }).click();
  await page.getByRole("heading", { name: "이 말, 어떻게 받아들여야 할까요?" }).waitFor();
  await page.getByRole("button", { name: "시작하기" }).click();
  check("초기화 후 관계 기본값", await page.getByLabel("연애").isChecked());
  await page.getByRole("button", { name: "다음" }).click();
  check("초기화 후 대화 입력 비어 있음", (await page.locator("textarea.tall").inputValue()) === "");
  check("초기화 후 상황 입력 비어 있음", (await page.locator("textarea").first().inputValue()) === "");

  // 빈 입력 처리(데모에서는 허용되지만 빈 화면 안내 표시)
  await page.getByRole("button", { name: "발화자 확인하기" }).click();
  check("빈 대화 안내", await page.getByText("입력한 대화가 없습니다", { exact: false }).isVisible());

  // 위험 사례: 대면 권유 제외 + 안전 안내
  await page.getByRole("button", { name: "대화 수정하기" }).click();
  await page.getByLabel("가상 사례").selectOption("safety");
  await page.getByRole("button", { name: "가상 사례 대화 넣기" }).click();
  await page.getByRole("button", { name: "발화자 확인하기" }).click();
  await page.getByRole("button", { name: "전송 내용 확인하기" }).click();
  await page.getByLabel("전송될 내용을 확인했고", { exact: false }).check();
  await page.getByRole("button", { name: "맥락 질문으로" }).click();
  await page.getByRole("button", { name: "가상 사례 결과 보기" }).click();
  await page.getByRole("heading", { name: "대화에서 살펴본 내용이에요" }).waitFor();
  check("위험 사례: 안전 안내", await page.getByText("안전을 먼저 생각해 주세요").isVisible());
  check("위험 사례: 112·1366 안내", (await page.locator(".notice-danger").innerText()).includes("1366"));
  check("위험 사례: 대면 권유 제외", !(await page.locator("main").innerText()).includes("직접 만나서 차분하게 이야기하기"));
  await shot("10-safety");

  // 자료 부족 사례
  await page.getByRole("button", { name: "입력 수정하고 다시 분석하기" }).click();
  await page.getByLabel("가상 사례").selectOption("hold");
  await page.getByRole("button", { name: "가상 사례 대화 넣기" }).click();
  await page.getByRole("button", { name: "발화자 확인하기" }).click();
  await page.getByRole("button", { name: "전송 내용 확인하기" }).click();
  await page.getByLabel("전송될 내용을 확인했고", { exact: false }).check();
  await page.getByRole("button", { name: "맥락 질문으로" }).click();
  await page.getByRole("button", { name: "가상 사례 결과 보기" }).click();
  await page.getByRole("heading", { name: "지금은 판단을 보류할게요" }).waitFor();
  check("자료 부족: 판단 보류", await page.getByText("판단 보류", { exact: true }).isVisible());
  await shot("11-hold");

  // 일부러 만든 502 응답 외의 콘솔 오류가 없어야 한다.
  const unexpected = consoleErrors.filter((t) => !t.includes("502"));
  check("예상치 못한 콘솔 오류 없음", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
  await context.close();

  // ── 실제 분석 모드 화면(서버 응답을 가로채 확인) ─────────────
  const live = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: "ko-KR" });
  const lp = await live.newPage();
  let sentBody = "";
  await lp.route("**/api/config", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: "live", provider: "anthropic", model: "claude-opus-5-5", reason: "configured" }) }),
  );
  await lp.route("**/api/analyze", (r) => {
    sentBody = r.request().postData() || "";
    return r.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: { code: "INPUT_TOO_LARGE", message: "입력 길이 제한을 넘었습니다. 대화나 설명을 줄여 주세요." } }) });
  });
  await lp.goto(BASE);
  await lp.getByRole("button", { name: "시작하기" }).click();
  await lp.getByRole("button", { name: "다음" }).click();
  await lp.getByRole("button", { name: "발화자 확인하기" }).click();
  check("실제 모드: 빈 대화 차단", await lp.getByRole("alert").filter({ hasText: "대화를 붙여 넣어 주세요" }).isVisible());
  await lp.locator("textarea").first().fill("민지가 보낸 말이에요");
  await lp.locator("textarea.tall").fill("민지: 너 요즘 왜 그래\n민지: 연락 좀 해 minji@test.com\n나: 미안 바빴어");
  await lp.getByRole("button", { name: "발화자 확인하기" }).click();
  await lp.getByRole("button", { name: "전송 내용 확인하기" }).click();
  check("실제 모드: 미지정 발화자 차단", await lp.getByRole("alert").filter({ hasText: "발화자가 정해지지 않은" }).isVisible());
  await lp.locator('input[name="sp-민지"][value="other"]').check();
  await lp.getByRole("button", { name: "전송 내용 확인하기" }).click();
  check("실제 모드: 외부 제공사 전송 안내", await lp.getByText("Anthropic", { exact: false }).first().isVisible());
  check("실제 모드: ‘완전 무저장’ 같은 보장 문구 없음", !(await lp.locator("main").innerText()).includes("완전 무저장"));
  await lp.getByLabel("전송될 내용을 확인했고", { exact: false }).check();
  await lp.getByRole("button", { name: "맥락 질문으로" }).click();
  await lp.getByRole("button", { name: "분석하기" }).click();
  await lp.getByRole("alert").filter({ hasText: "입력 길이 제한" }).waitFor();
  check("실제 모드: 크기 초과 오류 표시", true);
  check("실제 모드: 전송 본문에 이름·이메일 가림", !sentBody.includes("민지") && !sentBody.includes("minji@test.com") && sentBody.includes("[이메일]"));
  check("실제 모드: 전송 본문에 발화자 역할만", sentBody.includes('"role":"other"') && sentBody.includes('"role":"me"'));
  await lp.getByRole("button", { name: "이전" }).click();
  await lp.getByRole("button", { name: "이전" }).click();
  check("오류 후 뒤로 가도 입력 유지", (await lp.getByRole("heading", { name: "누가 한 말인지 확인해 주세요" }).isVisible()));
  await lp.getByRole("button", { name: "대화 수정하기" }).click();
  check("오류 후 대화 입력 유지", (await lp.locator("textarea.tall").inputValue()).includes("minji@test.com"));
  await live.close();

  // ── 응답 헤더·번들 점검 ─────────────
  const home = await fetch(BASE);
  check("CSP 헤더", !!home.headers.get("content-security-policy"));
  const api = await fetch(`${BASE}/api/config`);
  check("API no-store", (api.headers.get("cache-control") || "").includes("no-store"));
} catch (e) {
  failures++;
  results.push(`✘ 예외: ${e?.message || e}`);
} finally {
  await browser.close();
  stopServer();
}

console.log(results.join("\n"));
console.log(`\n${results.length - failures} / ${results.length} 통과`);
if (failures) {
  if (process.env.E2E_SERVER_LOG) console.log(serverLog);
  process.exit(1);
}
