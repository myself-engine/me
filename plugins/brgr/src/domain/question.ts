export type QuestionKind = "message" | "menu" | "screen";

export interface TaskQuestion {
  id: string;
  text: string;
  at: string;
  kind: QuestionKind;
  options?: string[];
}

export interface TaskAnswer {
  questionId: string;
  text: string | null;
  choice: string | null;
  at: string;
}

export const alreadyAnswered = (answers: TaskAnswer[], questionId: string) => answers.some((a) => a.questionId === questionId);
