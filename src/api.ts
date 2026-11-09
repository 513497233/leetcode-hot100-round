import { parseTime } from './round';

const ENDPOINT = 'https://leetcode.cn/graphql/';

export interface Problem {
  titleSlug: string;
  title: string;
  frontendId: string;
  difficulty: string;
  group: string;
}

export interface QuestionDetail {
  questionId: string;
  frontendId: string;
  title: string;
  content: string;
  exampleTestcases: string;
  snippets: { langSlug: string; code: string }[];
}

export function problemUrl(slug: string): string {
  return `https://leetcode.cn/problems/${slug}/`;
}

export class LeetCodeCn {
  constructor(private readonly cookie: string | undefined) {}

  private headers(referer = 'https://leetcode.cn/'): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Referer: referer,
      Origin: 'https://leetcode.cn',
    };
    if (this.cookie) {
      headers.Cookie = this.cookie;
      const csrf = /csrftoken=([^;\s]+)/.exec(this.cookie)?.[1];
      if (csrf) headers['x-csrftoken'] = csrf;
    }
    return headers;
  }

  private async rest<T>(method: 'GET' | 'POST', url: string, referer: string, body?: unknown): Promise<T> {
    const resp = await fetch(url, {
      method,
      headers: this.headers(referer),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) {
      const hint = resp.status === 401 || resp.status === 403 ? '（Cookie 无效或已过期，请重新绑定账号）' : '';
      throw new Error(`leetcode.cn 返回 HTTP ${resp.status}${hint}：${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`leetcode.cn 返回了非 JSON 内容：${text.slice(0, 200)}`);
    }
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const body = await this.rest<{ data?: T; errors?: { message: string }[] }>('POST', ENDPOINT, 'https://leetcode.cn/', {
      query,
      variables,
    });
    if (body.errors?.length) {
      throw new Error(`leetcode.cn GraphQL 错误: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    if (!body.data) throw new Error('leetcode.cn 返回空数据');
    return body.data;
  }

  async fetchHot100(): Promise<Problem[]> {
    const data = await this.gql<{
      studyPlanV2Detail: {
        planSubGroups: {
          name: string;
          questions: { titleSlug: string; translatedTitle: string; questionFrontendId: string; difficulty: string }[];
        }[];
      };
    }>(
      `query($slug: String!) { studyPlanV2Detail(planSlug: $slug) {
        planSubGroups { name questions { titleSlug translatedTitle questionFrontendId difficulty } } } }`,
      { slug: 'top-100-liked' },
    );
    return data.studyPlanV2Detail.planSubGroups.flatMap((g) =>
      g.questions.map((q) => ({
        titleSlug: q.titleSlug,
        title: q.translatedTitle,
        frontendId: q.questionFrontendId,
        difficulty: q.difficulty,
        group: g.name,
      })),
    );
  }

  async whoami(): Promise<{ signedIn: boolean; username: string }> {
    const data = await this.gql<{ userStatus: { isSignedIn: boolean; username: string } }>(
      '{ userStatus { isSignedIn username } }',
    );
    return { signedIn: data.userStatus.isSignedIn, username: data.userStatus.username };
  }

  async questionDetail(slug: string): Promise<QuestionDetail> {
    const data = await this.gql<{
      question: {
        questionId: string;
        questionFrontendId: string;
        translatedTitle: string;
        translatedContent: string;
        exampleTestcases: string;
        codeSnippets: { langSlug: string; code: string }[] | null;
      } | null;
    }>(
      `query($s: String!) { question(titleSlug: $s) {
        questionId questionFrontendId translatedTitle translatedContent exampleTestcases codeSnippets { langSlug code } } }`,
      { s: slug },
    );
    const q = data.question;
    if (!q) throw new Error(`找不到题目 ${slug}`);
    return {
      questionId: q.questionId,
      frontendId: q.questionFrontendId,
      title: q.translatedTitle,
      content: q.translatedContent,
      exampleTestcases: q.exampleTestcases,
      snippets: q.codeSnippets ?? [],
    };
  }

  /**
   * 账号做过的所有题的最后提交时间（毫秒）。用来粗筛：最后提交早于本轮开始的题，本轮肯定没 AC。
   * 拿不到（接口变了/返回 null）时返回 undefined，调用方退化为逐题查。
   */
  async lastSubmittedAt(): Promise<Map<string, number> | undefined> {
    const result = new Map<string, number>();
    const limit = 100;
    for (let skip = 0; skip < 5000; skip += limit) {
      const data = await this.gql<{
        userProgressQuestionList: { totalNum: number; questions: { titleSlug: string; lastSubmittedAt: string | null }[] } | null;
      }>(
        `query($f: UserProgressQuestionListInput) { userProgressQuestionList(filters: $f) {
          totalNum questions { titleSlug lastSubmittedAt } } }`,
        { f: { skip, limit } },
      );
      const page = data.userProgressQuestionList;
      if (!page) return undefined;
      for (const q of page.questions) {
        const t = parseTime(q.lastSubmittedAt);
        if (!Number.isNaN(t)) result.set(q.titleSlug, t);
      }
      if (page.questions.length < limit || skip + limit >= page.totalNum) break;
    }
    return result;
  }

  /** 统计该题 sinceMs 之后的提交次数、通过次数、最后提交时间。提交记录按时间倒序，翻到早于 sinceMs 就停。 */
  async submissionsSince(slug: string, sinceMs: number): Promise<{ count: number; ac: number; lastAt: number }> {
    const out = { count: 0, ac: 0, lastAt: 0 };
    let lastKey: string | null = null;
    for (let page = 0; page < 50; page++) {
      const data: {
        submissionList: { lastKey: string | null; hasNext: boolean; submissions: { statusDisplay: string; timestamp: string }[] };
      } = await this.gql(
        `query($s: String!, $k: String) { submissionList(offset: 0, limit: 20, questionSlug: $s, lastKey: $k) {
          lastKey hasNext submissions { statusDisplay timestamp } } }`,
        { s: slug, k: lastKey },
      );
      const list = data.submissionList;
      for (const sub of list.submissions) {
        const t = parseTime(sub.timestamp);
        if (t < sinceMs) return out;
        out.count++;
        if (sub.statusDisplay === 'Accepted') out.ac++;
        out.lastAt = Math.max(out.lastAt, t);
      }
      if (!list.hasNext || !list.lastKey) return out;
      lastKey = list.lastKey;
    }
    return out;
  }

  /** 云端测试，返回 interpret_id */
  async runTest(slug: string, questionId: string, lang: string, code: string, dataInput: string): Promise<string> {
    const r = await this.rest<{ interpret_id?: string; error?: string }>(
      'POST',
      `https://leetcode.cn/problems/${slug}/interpret_solution/`,
      problemUrl(slug),
      { lang, question_id: questionId, typed_code: code, data_input: dataInput },
    );
    if (!r.interpret_id) throw new Error(`测试请求被拒绝：${r.error ?? JSON.stringify(r)}`);
    return r.interpret_id;
  }

  /** 正式提交，返回 submission_id */
  async submit(slug: string, questionId: string, lang: string, code: string): Promise<string> {
    const r = await this.rest<{ submission_id?: number | string; error?: string }>(
      'POST',
      `https://leetcode.cn/problems/${slug}/submit/`,
      problemUrl(slug),
      { lang, question_id: questionId, typed_code: code },
    );
    if (r.submission_id === undefined) throw new Error(`提交请求被拒绝：${r.error ?? JSON.stringify(r)}`);
    return String(r.submission_id);
  }

  /** 轮询判题结果直到 state=SUCCESS */
  async waitResult<T extends { state?: string }>(id: string, slug: string, onTick?: (n: number) => void): Promise<T> {
    const intervalMs = 1000;
    const maxTries = 60;
    for (let i = 1; i <= maxTries; i++) {
      await new Promise((res) => setTimeout(res, intervalMs));
      onTick?.(i);
      const r = await this.rest<T>('GET', `https://leetcode.cn/submissions/detail/${id}/check/`, problemUrl(slug));
      if (r.state === 'SUCCESS') return r;
    }
    throw new Error(`判题超时（等待 ${(intervalMs * maxTries) / 1000}s 仍未出结果）`);
  }
}
