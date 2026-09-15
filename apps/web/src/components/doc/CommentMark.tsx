import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * Row 16: the highlight a comment leaves in the text. Carries the comment id;
 * clicking it asks the page to open that thread (custom event, no coupling).
 */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    commentMark: {
      setCommentMark: (commentId: string) => ReturnType;
      unsetCommentMark: (commentId?: string) => ReturnType;
    };
  }
}

export const CommentMark = Mark.create({
  name: "commentMark",
  inclusive: false,
  excludes: "",
  addAttributes() {
    return { commentId: { default: null, parseHTML: (el) => el.getAttribute("data-comment-id"), renderHTML: (a) => ({ "data-comment-id": a.commentId }) } };
  },
  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "doc-comment-mark" }), 0];
  },
  addCommands() {
    return {
      setCommentMark: (commentId) => ({ commands }) => commands.setMark(this.name, { commentId }),
      unsetCommentMark:
        (commentId) =>
        ({ tr, state, dispatch }) => {
          if (!commentId) return false;
          const type = state.schema.marks[this.name]!;
          state.doc.descendants((node, pos) => {
            const m = node.marks.find((x) => x.type === type && x.attrs.commentId === commentId);
            if (m) tr.removeMark(pos, pos + node.nodeSize, m);
          });
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});
