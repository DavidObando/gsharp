// <copyright file="GSharpFormatter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Formatting;

/// <summary>
/// Produces the single canonical G# source form defined by ADR-0179.
/// </summary>
public static class GSharpFormatter
{
    private const int MaxLineWidth = 120;

    private enum DiffKind
    {
        Equal,
        Delete,
        Insert,
    }

    /// <summary>
    /// Formats a complete source document.
    /// </summary>
    /// <param name="text">The source document.</param>
    /// <returns>The canonical text, edits, and any diagnostics.</returns>
    public static FormatResult Format(SourceText text)
    {
        ArgumentNullException.ThrowIfNull(text);
        return FormatCore(text, span: null);
    }

    /// <summary>
    /// Formats the source changes intersecting a requested span.
    /// </summary>
    /// <param name="text">The source document.</param>
    /// <param name="span">The requested source span.</param>
    /// <returns>The canonical text, intersecting edits, and any diagnostics.</returns>
    public static FormatResult Format(SourceText text, TextSpan span)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (span.Start < 0 || span.End > text.Length)
        {
            throw new ArgumentOutOfRangeException(nameof(span));
        }

        return FormatCore(text, span);
    }

    private static FormatResult FormatCore(SourceText original, TextSpan? span)
    {
        SourceText working = SortImports(original);
        SyntaxTree tree = SyntaxTree.Parse(working);
        if (tree.Diagnostics.Any(diagnostic => diagnostic.IsError))
        {
            return new FormatResult(
                null,
                ImmutableArray<TextEdit>.Empty,
                tree.Diagnostics,
                Changed: false);
        }

        var builder = new LayoutBuilder(tree);
        string formatted = Doc.Render(builder.Build(), MaxLineWidth).TrimEnd(' ', '\t', '\r', '\n') + "\n";
        SourceText formattedText = SourceText.From(formatted, original.FileName);

        ImmutableArray<Diagnostic> validationDiagnostics = ValidateRoundTrip(working, tree, formattedText);
        if (!validationDiagnostics.IsEmpty)
        {
            return new FormatResult(
                null,
                ImmutableArray<TextEdit>.Empty,
                validationDiagnostics,
                Changed: false);
        }

        string originalString = original.ToString();
        if (formatted == originalString)
        {
            return new FormatResult(
                formattedText,
                ImmutableArray<TextEdit>.Empty,
                ImmutableArray<Diagnostic>.Empty,
                Changed: false);
        }

        ImmutableArray<TextEdit> edits = CreateLineEdits(
            originalString,
            formatted,
            compareLineContentOnly: span is not null);
        if (span is TextSpan requested)
        {
            TextSpan requestedLines = ExpandToFullLines(original, requested);
            edits = edits.Where(edit => Intersects(edit.Span, requestedLines)).ToImmutableArray();
            if (edits.IsEmpty)
            {
                return new FormatResult(
                    original,
                    ImmutableArray<TextEdit>.Empty,
                    ImmutableArray<Diagnostic>.Empty,
                    Changed: false);
            }
        }

        SourceText resultText = span is null
            ? formattedText
            : SourceText.From(ApplyEdits(originalString, edits), original.FileName);
        return new FormatResult(
            resultText,
            edits,
            ImmutableArray<Diagnostic>.Empty,
            Changed: true);
    }

    private static SourceText SortImports(SourceText original)
    {
        SyntaxTree tree = SyntaxTree.Parse(original);
        if (tree.Diagnostics.Any(diagnostic => diagnostic.IsError))
        {
            return original;
        }

        ImportSyntax[] imports = tree.Root.Members.OfType<ImportSyntax>().ToArray();
        if (imports.Length < 2)
        {
            return original;
        }

        string source = original.ToString();
        for (int i = 1; i < imports.Length; i++)
        {
            string gap = source.Substring(imports[i - 1].Span.End, imports[i].Span.Start - imports[i - 1].Span.End);
            if (gap.Any(character => !char.IsWhiteSpace(character)))
            {
                return original;
            }
        }

        string[] lines = imports
            .Select(import => source.Substring(import.Span.Start, import.Span.Length).Trim())
            .OrderBy(line => line, StringComparer.Ordinal)
            .ToArray();
        if (lines.SequenceEqual(
            imports.Select(import => source.Substring(import.Span.Start, import.Span.Length).Trim()),
            StringComparer.Ordinal))
        {
            return original;
        }

        int start = imports[0].Span.Start;
        int end = imports[^1].Span.End;
        string sorted = string.Join("\n", lines);
        return SourceText.From(
            source.Substring(0, start) + sorted + source.Substring(end),
            original.FileName);
    }

    private static ImmutableArray<Diagnostic> ValidateRoundTrip(
        SourceText input,
        SyntaxTree inputTree,
        SourceText formatted)
    {
        SyntaxTree formattedTree = SyntaxTree.Parse(formatted);
        if (formattedTree.Diagnostics.Any(diagnostic => diagnostic.IsError))
        {
            return formattedTree.Diagnostics;
        }

        if (!string.Equals(inputTree.Root.ToString(), formattedTree.Root.ToString(), StringComparison.Ordinal)
            || !SignificantTokens(input).SequenceEqual(SignificantTokens(formatted), StringComparer.Ordinal)
            || !Comments(input).SequenceEqual(Comments(formatted), StringComparer.Ordinal))
        {
            var location = new TextLocation(input, new TextSpan(0, 0));
            return ImmutableArray.Create(new Diagnostic(
                location,
                "GSF0001",
                DiagnosticSeverity.Error,
                "Formatting was rejected because it changed the parsed program or source comments."));
        }

        return ImmutableArray<Diagnostic>.Empty;
    }

    private static IEnumerable<string> SignificantTokens(SourceText text)
    {
        foreach (SyntaxToken token in SyntaxTree.ParseTokens(text))
        {
            if (token.Kind is SyntaxKind.WhitespaceToken
                or SyntaxKind.CommentToken
                or SyntaxKind.DocumentationCommentToken)
            {
                continue;
            }

            yield return ((int)token.Kind).ToString(System.Globalization.CultureInfo.InvariantCulture)
                + "\0"
                + token.ValueText;
        }
    }

    private static IEnumerable<string> Comments(SourceText text) =>
        SyntaxTree.ParseTokens(text)
            .Where(token => token.Kind is SyntaxKind.CommentToken or SyntaxKind.DocumentationCommentToken)
            .Select(token => token.ValueText)
            .OrderBy(comment => comment, StringComparer.Ordinal);

    private static ImmutableArray<TextEdit> CreateLineEdits(
        string original,
        string formatted,
        bool compareLineContentOnly)
    {
        string[] originalLines = SplitLines(original);
        string[] formattedLines = SplitLines(formatted);
        List<DiffOperation> operations = DiffLines(
            originalLines,
            formattedLines,
            compareLineContentOnly);
        int[] offsets = new int[originalLines.Length + 1];
        for (int i = 0; i < originalLines.Length; i++)
        {
            offsets[i + 1] = offsets[i] + originalLines[i].Length;
        }

        var edits = ImmutableArray.CreateBuilder<TextEdit>();
        int originalIndex = 0;
        int hunkStart = -1;
        int deletedLines = 0;
        var replacement = new System.Text.StringBuilder();

        void Flush()
        {
            if (hunkStart < 0)
            {
                return;
            }

            int start = offsets[hunkStart];
            int end = offsets[hunkStart + deletedLines];
            edits.Add(new TextEdit(TextSpan.FromBounds(start, end), replacement.ToString()));
            hunkStart = -1;
            deletedLines = 0;
            replacement.Clear();
        }

        foreach (DiffOperation operation in operations)
        {
            switch (operation.Kind)
            {
                case DiffKind.Equal:
                    Flush();
                    originalIndex++;
                    break;
                case DiffKind.Delete:
                    hunkStart = hunkStart < 0 ? originalIndex : hunkStart;
                    deletedLines++;
                    originalIndex++;
                    break;
                case DiffKind.Insert:
                    hunkStart = hunkStart < 0 ? originalIndex : hunkStart;
                    replacement.Append(operation.Text);
                    break;
            }
        }

        Flush();
        return edits.Count == 0
            ? ImmutableArray.Create(new TextEdit(new TextSpan(0, original.Length), formatted))
            : edits.ToImmutable();
    }

    private static string ApplyEdits(string source, ImmutableArray<TextEdit> edits)
    {
        for (int i = edits.Length - 1; i >= 0; i--)
        {
            TextEdit edit = edits[i];
            source = source.Substring(0, edit.Span.Start)
                + edit.NewText
                + source.Substring(edit.Span.End);
        }

        return source;
    }

    private static string[] SplitLines(string text)
    {
        var lines = new List<string>();
        int start = 0;
        for (int i = 0; i < text.Length; i++)
        {
            if (text[i] != '\n')
            {
                continue;
            }

            lines.Add(text.Substring(start, i - start + 1));
            start = i + 1;
        }

        if (start < text.Length)
        {
            lines.Add(text.Substring(start));
        }

        return lines.ToArray();
    }

    private static List<DiffOperation> DiffLines(
        string[] original,
        string[] formatted,
        bool compareLineContentOnly)
    {
        int maximum = original.Length + formatted.Length;
        int offset = maximum + 1;
        var frontier = Enumerable.Repeat(-1, (maximum * 2) + 3).ToArray();
        frontier[offset + 1] = 0;
        var trace = new List<int[]>();
        int distance = 0;

        for (; distance <= maximum; distance++)
        {
            trace.Add((int[])frontier.Clone());
            for (int diagonal = -distance; diagonal <= distance; diagonal += 2)
            {
                int frontierIndex = offset + diagonal;
                int x = diagonal == -distance
                    || (diagonal != distance
                        && frontier[frontierIndex - 1] < frontier[frontierIndex + 1])
                    ? frontier[frontierIndex + 1]
                    : frontier[frontierIndex - 1] + 1;
                int y = x - diagonal;
                while (x < original.Length
                    && y < formatted.Length
                    && LinesEqual(original[x], formatted[y], compareLineContentOnly))
                {
                    x++;
                    y++;
                }

                frontier[frontierIndex] = x;
                if (x >= original.Length && y >= formatted.Length)
                {
                    return BacktrackDiff(trace, original, formatted, distance, offset);
                }
            }
        }

        throw new InvalidOperationException("Line diff did not converge.");
    }

    private static bool LinesEqual(string left, string right, bool compareContentOnly) =>
        string.Equals(
            compareContentOnly ? left.TrimEnd('\r', '\n') : left,
            compareContentOnly ? right.TrimEnd('\r', '\n') : right,
            StringComparison.Ordinal);

    private static List<DiffOperation> BacktrackDiff(
        List<int[]> trace,
        string[] original,
        string[] formatted,
        int distance,
        int offset)
    {
        int x = original.Length;
        int y = formatted.Length;
        var reversed = new List<DiffOperation>();

        for (int depth = distance; depth >= 0; depth--)
        {
            int[] frontier = trace[depth];
            int diagonal = x - y;
            int previousDiagonal = diagonal == -depth
                || (diagonal != depth
                    && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1])
                ? diagonal + 1
                : diagonal - 1;
            int previousX = frontier[offset + previousDiagonal];
            int previousY = previousX - previousDiagonal;

            while (x > previousX && y > previousY)
            {
                reversed.Add(new DiffOperation(DiffKind.Equal, original[x - 1]));
                x--;
                y--;
            }

            if (depth == 0)
            {
                break;
            }

            if (x == previousX)
            {
                reversed.Add(new DiffOperation(DiffKind.Insert, formatted[previousY]));
                y--;
            }
            else
            {
                reversed.Add(new DiffOperation(DiffKind.Delete, original[previousX]));
                x--;
            }
        }

        reversed.Reverse();
        return reversed;
    }

    private static bool Intersects(TextSpan left, TextSpan right) =>
        left.Start <= right.End && right.Start <= left.End;

    private static TextSpan ExpandToFullLines(SourceText text, TextSpan span)
    {
        int startLine = text.GetLineIndex(Math.Min(span.Start, Math.Max(0, text.Length - 1)));
        int endPosition = Math.Min(Math.Max(span.Start, span.End), Math.Max(0, text.Length - 1));
        int endLine = text.GetLineIndex(endPosition);
        TextLine end = text.Lines[endLine];
        return TextSpan.FromBounds(text.Lines[startLine].Start, end.Start + end.LengthIncludingLineBreak);
    }

    private readonly record struct DiffOperation(DiffKind Kind, string Text);

    private sealed class LayoutBuilder
    {
        private readonly SyntaxTree tree;
        private readonly List<LayoutToken> tokens;
        private readonly Dictionary<int, int> matchingDelimiters = new();
        private readonly Dictionary<int, int> breaksBefore = new();

        public LayoutBuilder(SyntaxTree tree)
        {
            this.tree = tree;
            tokens = BindTrivia(tree);
            BuildDelimiterMap();
            BuildLineBoundaries();
        }

        public Doc Build() => tokens.Count == 0
            ? Doc.HardLine
            : BuildRange(0, tokens.Count, suppressLeadingBreak: true, groupSegments: true);

        private static List<LayoutToken> BindTrivia(SyntaxTree tree)
        {
            var parsedTokens = EnumerateTokens(tree.Root)
                .Where(token => !token.IsMissing)
                .GroupBy(token => (token.Position, token.Kind, token.Text))
                .ToDictionary(group => group.Key, group => group.First().Parent);
            var result = new List<LayoutToken>();
            int pendingNewlines = 0;

            foreach (SyntaxToken token in SyntaxTree.ParseTokens(tree.Text))
            {
                if (token.Kind == SyntaxKind.WhitespaceToken)
                {
                    pendingNewlines += CountNewlines(token.Text);
                    continue;
                }

                parsedTokens.TryGetValue((token.Position, token.Kind, token.Text), out SyntaxNode? parent);
                result.Add(new LayoutToken(
                    token,
                    parent,
                    Math.Min(2, pendingNewlines),
                    IsLineComment(token),
                    NormalizeTokenText(token)));
                pendingNewlines = 0;
            }

            return result;
        }

        private static IEnumerable<SyntaxToken> EnumerateTokens(SyntaxNode node)
        {
            if (node is SyntaxToken token)
            {
                yield return token;
                yield break;
            }

            foreach (SyntaxNode child in node.GetChildren())
            {
                foreach (SyntaxToken descendant in EnumerateTokens(child))
                {
                    yield return descendant;
                }
            }
        }

        private static int CountNewlines(string text)
        {
            int count = 0;
            for (int i = 0; i < text.Length; i++)
            {
                if (text[i] == '\n' || (text[i] == '\r' && (i + 1 >= text.Length || text[i + 1] != '\n')))
                {
                    count++;
                }
            }

            return count;
        }

        private static bool IsLineComment(SyntaxToken token) =>
            token.Kind == SyntaxKind.DocumentationCommentToken
            || (token.Kind == SyntaxKind.CommentToken && token.Text.StartsWith("//", StringComparison.Ordinal));

        private static string NormalizeTokenText(SyntaxToken token) =>
            IsLineComment(token) ? token.Text.TrimEnd('\r', '\n') : token.Text;

        private void BuildDelimiterMap()
        {
            var stack = new Stack<int>();
            for (int i = 0; i < tokens.Count; i++)
            {
                SyntaxKind kind = tokens[i].Token.Kind;
                if (kind is SyntaxKind.OpenParenthesisToken
                    or SyntaxKind.OpenSquareBracketToken
                    or SyntaxKind.QuestionOpenBracketToken
                    or SyntaxKind.OpenBraceToken)
                {
                    stack.Push(i);
                    continue;
                }

                if (kind is not (SyntaxKind.CloseParenthesisToken
                    or SyntaxKind.CloseSquareBracketToken
                    or SyntaxKind.CloseBraceToken))
                {
                    continue;
                }

                if (stack.Count == 0)
                {
                    continue;
                }

                int open = stack.Pop();
                if (IsMatching(tokens[open].Token.Kind, kind))
                {
                    matchingDelimiters[open] = i;
                }
            }
        }

        private static bool IsMatching(SyntaxKind open, SyntaxKind close) =>
            (open == SyntaxKind.OpenParenthesisToken && close == SyntaxKind.CloseParenthesisToken)
            || (open is SyntaxKind.OpenSquareBracketToken or SyntaxKind.QuestionOpenBracketToken
                && close == SyntaxKind.CloseSquareBracketToken)
            || (open == SyntaxKind.OpenBraceToken && close == SyntaxKind.CloseBraceToken);

        private void BuildLineBoundaries()
        {
            foreach (SyntaxNode parent in tree.Root.DescendantNodesAndSelf())
            {
                if (!IsLineContainer(parent))
                {
                    continue;
                }

                SyntaxNode[] children = parent.GetChildren()
                    .Where(IsLineItem)
                    .OrderBy(child => child.Span.Start)
                    .ToArray();
                for (int i = 1; i < children.Length; i++)
                {
                    int breakCount = IsMemberBlankLine(children[i - 1], children[i]) ? 2 : 1;
                    breaksBefore[LeadingTriviaPosition(children[i].Span.Start)] = breakCount;
                }
            }
        }

        private int LeadingTriviaPosition(int position)
        {
            int index = tokens.FindIndex(token => token.Token.Position == position);
            if (index < 0)
            {
                return position;
            }

            while (index > 0
                && tokens[index - 1].Token.Kind is SyntaxKind.CommentToken
                    or SyntaxKind.DocumentationCommentToken
                && IsStandaloneComment(tokens[index - 1]))
            {
                index--;
            }

            return tokens[index].Token.Position;
        }

        private bool IsStandaloneComment(LayoutToken token)
        {
            if (token.Token.Kind == SyntaxKind.DocumentationCommentToken || token.NewlinesBefore > 0)
            {
                return true;
            }

            int line = tree.Text.GetLineIndex(token.Token.Position);
            int lineStart = tree.Text.Lines[line].Start;
            string prefix = tree.Text.ToString(lineStart, token.Token.Position - lineStart);
            return prefix.All(char.IsWhiteSpace);
        }

        private static bool IsLineContainer(SyntaxNode node) =>
            node is CompilationUnitSyntax
                or BlockStatementSyntax
                or StructDeclarationSyntax
                or InterfaceDeclarationSyntax
                or EnumDeclarationSyntax
                or SharedBlockSyntax
                or SwitchStatementSyntax
                or SwitchExpressionSyntax
                or SelectStatementSyntax
                or PropertyDeclarationSyntax
                or EventDeclarationSyntax
                or AnonymousClassExpressionSyntax;

        private static bool IsLineItem(SyntaxNode node) =>
            node is MemberSyntax
                or StatementSyntax
                or SwitchCaseSyntax
                or SwitchExpressionArmSyntax
                or SelectCaseSyntax
                or EnumMemberSyntax
                or PropertyAccessorSyntax
                or EventAccessorSyntax
                or AnonymousClassMemberInitializerSyntax;

        private static bool IsMemberBlankLine(SyntaxNode previous, SyntaxNode current)
        {
            if (previous is ImportSyntax && current is ImportSyntax)
            {
                return false;
            }

            if (previous is PackageSyntax || previous is ImportSyntax || current is ImportSyntax)
            {
                return true;
            }

            return IsDeclarationMember(previous) && IsDeclarationMember(current);
        }

        private static bool IsDeclarationMember(SyntaxNode node) =>
            node is MemberSyntax
            && node is not GlobalStatementSyntax
            && node is not PackageSyntax
            && node is not ImportSyntax;

        private Doc BuildRange(int start, int end, bool suppressLeadingBreak, bool groupSegments)
        {
            var completed = new List<Doc>();
            var segment = new List<Doc>();
            LayoutToken? previous = null;
            int index = start;

            while (index < end)
            {
                LayoutToken current = tokens[index];
                int breakCount = GetBreakCount(previous, current, suppressLeadingBreak && index == start);
                if (breakCount > 0)
                {
                    FlushSegment(completed, segment, groupSegments);
                    AddHardLines(completed, breakCount);
                    previous = null;
                }
                else if (previous is not null)
                {
                    segment.Add(InlineSeparator(previous, current));
                }

                if (matchingDelimiters.TryGetValue(index, out int close) && close < end)
                {
                    if (current.Token.Kind == SyntaxKind.OpenBraceToken && IsStructuralBrace(current.Parent))
                    {
                        segment.Add(Doc.Text(current.Text));
                        if (close == index + 1)
                        {
                            segment.Add(Doc.Text(" "));
                            segment.Add(Doc.Text(tokens[close].Text));
                        }
                        else
                        {
                            FlushSegment(completed, segment, groupSegments);
                            Doc inner = BuildRange(
                                index + 1,
                                close,
                                suppressLeadingBreak: true,
                                groupSegments: true);
                            completed.Add(Doc.Nest(4, Doc.Concat(Doc.HardLine, inner)));
                            completed.Add(Doc.HardLine);
                            segment.Add(Doc.Text(tokens[close].Text));
                        }
                    }
                    else
                    {
                        Doc inner = BuildRange(
                            index + 1,
                            close,
                            suppressLeadingBreak: true,
                            groupSegments: false);
                        Doc delimited = close == index + 1
                            ? Doc.Concat(Doc.Text(current.Text), Doc.Text(tokens[close].Text))
                            : Doc.Group(Doc.Concat(
                                Doc.Text(current.Text),
                                Doc.Nest(4, Doc.Concat(Doc.SoftLine, inner)),
                                Doc.SoftLine,
                                Doc.Text(tokens[close].Text)));
                        segment.Add(delimited);
                    }

                    previous = tokens[close];
                    index = close + 1;
                    continue;
                }

                segment.Add(Doc.Text(current.Text));
                if (current.IsLineComment)
                {
                    FlushSegment(completed, segment, groupSegments);
                    completed.Add(Doc.HardLine);
                    previous = null;
                }
                else
                {
                    previous = current;
                }

                index++;
            }

            FlushSegment(completed, segment, groupSegments);
            return Doc.Concat(completed);
        }

        private int GetBreakCount(LayoutToken? previous, LayoutToken current, bool suppressLeadingBreak)
        {
            if (suppressLeadingBreak)
            {
                return 0;
            }

            if (previous is null)
            {
                return current.NewlinesBefore;
            }

            if (breaksBefore.TryGetValue(current.Token.Position, out int required))
            {
                return Math.Max(required, current.NewlinesBefore);
            }

            if (SyntaxFacts.IsBreakRequiredBetween(previous.Token, current.Token))
            {
                return 1;
            }

            if (current.NewlinesBefore == 0)
            {
                return 0;
            }

            if (current.Token.Kind == SyntaxKind.OpenBraceToken && IsStructuralBrace(current.Parent))
            {
                return 0;
            }

            if (IsContinuationBoundary(previous.Token.Kind, current.Token.Kind)
                && SyntaxFacts.IsBreakLegalBetween(previous.Token, current.Token))
            {
                return 0;
            }

            if (previous.Token.Kind == SyntaxKind.CloseBraceToken
                && current.Token.Kind is SyntaxKind.ElseKeyword
                    or SyntaxKind.CatchKeyword
                    or SyntaxKind.FinallyKeyword
                    or SyntaxKind.WhileKeyword)
            {
                return 0;
            }

            return current.NewlinesBefore;
        }

        private static bool IsContinuationBoundary(SyntaxKind previous, SyntaxKind current) =>
            previous is SyntaxKind.OpenParenthesisToken
                or SyntaxKind.OpenSquareBracketToken
                or SyntaxKind.QuestionOpenBracketToken
                or SyntaxKind.CommaToken
                or SyntaxKind.PlusToken
                or SyntaxKind.AmpersandAmpersandToken
                or SyntaxKind.PipePipeToken
            || current is SyntaxKind.CloseParenthesisToken
                or SyntaxKind.CloseSquareBracketToken
                or SyntaxKind.DotToken
                or SyntaxKind.QuestionDotToken;

        private static Doc InlineSeparator(LayoutToken previous, LayoutToken current)
        {
            SyntaxKind left = previous.Token.Kind;
            SyntaxKind right = current.Token.Kind;

            if (left == SyntaxKind.CommaToken)
            {
                return Doc.Line;
            }

            if (left is SyntaxKind.PlusToken
                or SyntaxKind.AmpersandAmpersandToken
                or SyntaxKind.PipePipeToken)
            {
                return Doc.Nest(4, Doc.Line);
            }

            if (right is SyntaxKind.DotToken or SyntaxKind.QuestionDotToken)
            {
                return Doc.Nest(4, Doc.SoftLine);
            }

            if (left is SyntaxKind.DotToken or SyntaxKind.QuestionDotToken
                or SyntaxKind.AtToken
                or SyntaxKind.OpenParenthesisToken
                or SyntaxKind.OpenSquareBracketToken
                or SyntaxKind.QuestionOpenBracketToken
                || right is SyntaxKind.CloseParenthesisToken
                    or SyntaxKind.CloseSquareBracketToken
                    or SyntaxKind.CommaToken
                    or SyntaxKind.SemicolonToken
                    or SyntaxKind.DotToken
                    or SyntaxKind.QuestionDotToken)
            {
                return Doc.Empty;
            }

            if (right == SyntaxKind.OpenParenthesisToken
                && left is SyntaxKind.IdentifierToken
                    or SyntaxKind.CloseParenthesisToken
                    or SyntaxKind.CloseSquareBracketToken)
            {
                return Doc.Empty;
            }

            if (right == SyntaxKind.OpenSquareBracketToken
                && left is SyntaxKind.IdentifierToken
                    or SyntaxKind.CloseParenthesisToken
                    or SyntaxKind.CloseSquareBracketToken)
            {
                return Doc.Empty;
            }

            if (left == SyntaxKind.CloseSquareBracketToken
                && right is SyntaxKind.IdentifierToken or SyntaxKind.QuestionToken)
            {
                return Doc.Empty;
            }

            if (right == SyntaxKind.OpenBraceToken && !IsStructuralBrace(current.Parent))
            {
                return left is SyntaxKind.IdentifierToken
                    or SyntaxKind.CloseParenthesisToken
                    or SyntaxKind.CloseSquareBracketToken
                    ? Doc.Empty
                    : Doc.Text(" ");
            }

            if (right == SyntaxKind.OpenBraceToken)
            {
                return Doc.Text(" ");
            }

            if (right == SyntaxKind.ColonToken)
            {
                return NeedsSpaceBeforeColon(current.Parent) ? Doc.Text(" ") : Doc.Empty;
            }

            if (left == SyntaxKind.ColonToken)
            {
                return Doc.Text(" ");
            }

            if (IsPostfix(current))
            {
                return Doc.Empty;
            }

            if (IsPrefix(previous))
            {
                return Doc.Empty;
            }

            if (IsNullableMarker(previous) || IsNullableMarker(current))
            {
                return Doc.Empty;
            }

            return Doc.Text(" ");
        }

        private static bool IsStructuralBrace(SyntaxNode? parent) =>
            parent is BlockStatementSyntax
                or StructDeclarationSyntax
                or InterfaceDeclarationSyntax
                or EnumDeclarationSyntax
                or SharedBlockSyntax
                or SwitchStatementSyntax
                or SwitchExpressionSyntax
                or SelectStatementSyntax
                or PropertyDeclarationSyntax
                or EventDeclarationSyntax
                or BlockExpressionSyntax;

        private static bool NeedsSpaceBeforeColon(SyntaxNode? parent) =>
            parent is StructDeclarationSyntax
                or InterfaceDeclarationSyntax
                or ConstructorDeclarationSyntax;

        private static bool IsPostfix(LayoutToken token) =>
            token.Token.Kind is SyntaxKind.BangBangToken
                or SyntaxKind.PlusPlusToken
                or SyntaxKind.MinusMinusToken
            || (token.Token.Kind == SyntaxKind.QuestionToken && IsNullableMarker(token));

        private static bool IsPrefix(LayoutToken token)
        {
            if (token.Parent is UnaryExpressionSyntax
                or FromEndIndexExpressionSyntax
                or SpreadElementExpressionSyntax)
            {
                return true;
            }

            return token.Token.Kind is SyntaxKind.BangToken or SyntaxKind.AtToken
                || (token.Token.Kind is SyntaxKind.StarToken
                    or SyntaxKind.AmpersandToken
                    or SyntaxKind.EllipsisToken
                    && token.Parent is TypeClauseSyntax or ParameterSyntax);
        }

        private static bool IsNullableMarker(LayoutToken token) =>
            token.Token.Kind == SyntaxKind.QuestionToken
            && token.Parent is TypeClauseSyntax;

        private static void FlushSegment(List<Doc> completed, List<Doc> segment, bool group)
        {
            if (segment.Count == 0)
            {
                return;
            }

            Doc document = Doc.Concat(segment);
            completed.Add(group ? Doc.Group(document) : document);
            segment.Clear();
        }

        private static void AddHardLines(List<Doc> completed, int count)
        {
            completed.Add(Doc.HardLine);
            if (count > 1)
            {
                completed.Add(Doc.HardLine);
            }
        }

        private sealed class LayoutToken
        {
            public LayoutToken(
                SyntaxToken token,
                SyntaxNode? parent,
                int newlinesBefore,
                bool isLineComment,
                string text)
            {
                Token = token;
                Parent = parent;
                NewlinesBefore = newlinesBefore;
                IsLineComment = isLineComment;
                Text = text;
            }

            public SyntaxToken Token { get; }

            public SyntaxNode? Parent { get; }

            public int NewlinesBefore { get; }

            public bool IsLineComment { get; }

            public string Text { get; }
        }
    }
}
