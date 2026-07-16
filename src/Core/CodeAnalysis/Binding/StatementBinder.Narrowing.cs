// <copyright file="StatementBinder.Narrowing.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class StatementBinder
{
    /// <summary>
    /// If <paramref name="statement"/> is a call expression statement whose
    /// called function carries <c>[MemberNotNull("_f", …)]</c>, narrows each
    /// named field (via its <see cref="ImplicitFieldVariableSymbol"/>) to its
    /// underlying non-nullable type in <paramref name="frame"/>.
    /// </summary>
    private void ApplyMemberNotNullNarrowings(BoundStatement statement, Dictionary<AccessPath, TypeSymbol> frame)
    {
        BoundExpression callExpr = null;
        if (statement is BoundExpressionStatement exprStmt)
        {
            callExpr = exprStmt.Expression;
        }

        if (callExpr == null)
        {
            return;
        }

        ImmutableArray<string> memberNames;
        switch (callExpr)
        {
            case BoundCallExpression userCall:
                if (!KnownAttributes.TryGetMemberNotNullMembers(userCall.Function.Attributes, out memberNames))
                {
                    return;
                }

                break;

            case BoundImportedCallExpression importedCall:
                if (!ClrNullability.TryGetMemberNotNullMembers(importedCall.Function.Method, out memberNames))
                {
                    return;
                }

                break;

            case BoundImportedInstanceCallExpression instanceCall:
                if (!ClrNullability.TryGetMemberNotNullMembers(instanceCall.Method, out memberNames))
                {
                    return;
                }

                break;

            case BoundUserInstanceCallExpression userInstanceCall:
                if (!KnownAttributes.TryGetMemberNotNullMembers(userInstanceCall.Method.Attributes, out memberNames))
                {
                    return;
                }

                break;

            default:
                return;
        }

        foreach (var name in memberNames)
        {
            NarrowFieldIfNullable(name, frame);
        }
    }

    /// <summary>
    /// Looks up <paramref name="fieldName"/> in the current scope. If it
    /// resolves to an <see cref="ImplicitFieldVariableSymbol"/> whose declared
    /// type is nullable, adds a narrowing entry to <paramref name="frame"/>
    /// that maps the symbol to its underlying non-nullable type.
    /// </summary>
    private void NarrowFieldIfNullable(string fieldName, Dictionary<AccessPath, TypeSymbol> frame)
    {
        if (scope.TryLookupSymbol(fieldName) is ImplicitFieldVariableSymbol fieldVar
            && fieldVar.Type is NullableTypeSymbol nullable)
        {
            frame[fieldVar] = nullable.UnderlyingType;
        }
    }

    private void InvalidateNarrowingsForAssignedVariables(SyntaxNode statementSyntax)
    {
        // Issue #1639: `NarrowedVariables.Count == 0` never fires in practice —
        // `BindBlockStatements` pushes a (usually empty) memberNotNullFrame for
        // every block, so the list always has at least one entry once binding
        // is inside any block. The real fast-path question is whether any
        // active frame actually holds a narrowing; if none do, no walk of the
        // statement's syntax subtree can possibly invalidate anything, so skip
        // both walks (and their HashSet/List allocations) entirely.
        if (!HasAnyActiveNarrowings())
        {
            return;
        }

        // ADR-0069 addendum / issue #1180: member-path narrowings are far more
        // fragile than local narrowings. Any call could mutate a field reached
        // through the chain, and any member/index/indirect assignment could too,
        // so — matching the Kotlin guarantee that a smart cast only survives
        // when the compiler can prove the value is unchanged — we conservatively
        // drop EVERY member-bearing path when the statement contains a call or a
        // member-mutating assignment. Plain variable narrowings keep their
        // existing, more permissive invalidation (reassignment only).
        //
        // Issue #1639: both the assigned-name collection and the member-mutation
        // check used to walk the full statement syntax subtree separately. They
        // gather independent facts from the same tree, so a single combined
        // walk collects both in one pass instead of two.
        var assignedNames = new HashSet<string>();
        var dropAllMemberPaths = CollectAssignedNamesAndMemberMutation(statementSyntax, assignedNames);

        // Resolve the set of reassigned root variables so we can also drop any
        // member path rooted at one of them.
        var assignedRoots = new HashSet<VariableSymbol>();
        foreach (var name in assignedNames)
        {
            if (scope.TryLookupSymbol(name) is VariableSymbol v)
            {
                assignedRoots.Add(v);
            }
        }

        if (assignedRoots.Count == 0 && !dropAllMemberPaths)
        {
            return;
        }

        // Resolve each name through the current scope and drop any matching
        // narrowing from ALL active frames. We don't need to be conservative
        // about scope shadowing: the narrowed variable lives in an outer scope,
        // so an inner shadowing declaration with the same name will resolve to a
        // different symbol, and the narrowing will simply not be triggered.
        // Issue #208: iterate ALL frames (not just the top) because the
        // memberNotNullFrame sits above the if-condition frames; dropping from
        // only the top would miss narrowings added by if-condition analysis.
        for (var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i--)
        {
            var frame = binderCtx.NarrowedVariables[i];
            if (frame.Count == 0)
            {
                continue;
            }

            List<AccessPath> toRemove = null;
            foreach (var key in frame.Keys)
            {
                var drop = assignedRoots.Contains(key.Root)
                    || (key.HasMembers && dropAllMemberPaths);
                if (drop)
                {
                    (toRemove ??= new List<AccessPath>()).Add(key);
                }
            }

            if (toRemove != null)
            {
                foreach (var key in toRemove)
                {
                    frame.Remove(key);
                }
            }
        }
    }

    /// <summary>
    /// Issue #1639: returns whether any currently active narrowing frame holds
    /// at least one entry. Used as the fast-path guard before walking a
    /// statement's syntax subtree for invalidation purposes — a block's
    /// persistent <c>memberNotNullFrame</c> is pushed unconditionally (even
    /// when empty), so testing <see cref="BinderContext.NarrowedVariables"/>
    /// for emptiness alone never short-circuits. Frame counts are typically
    /// shallow (bounded by nesting depth), so this scan is cheap relative to a
    /// syntax subtree walk.
    /// </summary>
    private bool HasAnyActiveNarrowings()
    {
        for (var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i--)
        {
            if (binderCtx.NarrowedVariables[i].Count > 0)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0069 addendum / issue #1180 / issue #1639: combined single-pass walk
    /// that collects both facts previously gathered by two separate full
    /// subtree walks: (a) the set of plain-variable names reassigned anywhere
    /// in <paramref name="node"/>, added to <paramref name="assigned"/>, and
    /// (b) whether the subtree contains a construct that could change a value
    /// reached through a stable member path — a call (whose callee could
    /// mutate a field), or a member / index / indirect assignment — returned
    /// as the method result. Such statements conservatively invalidate all
    /// member-path smart casts.
    /// </summary>
    private static bool CollectAssignedNamesAndMemberMutation(SyntaxNode node, HashSet<string> assigned)
    {
        var mayMutateMemberPaths = false;
        switch (node)
        {
            case CallExpressionSyntax:
            case MemberFieldAssignmentExpressionSyntax:
            case MemberIndexAssignmentExpressionSyntax:
            case IndexAssignmentExpressionSyntax:
            case CompoundIndexAssignmentExpressionSyntax:
            case IndirectAssignmentExpressionSyntax:
            case IndirectCompoundAssignmentExpressionSyntax:
            case FieldAssignmentExpressionSyntax:
                mayMutateMemberPaths = true;
                break;
            case AssignmentExpressionSyntax a:
                assigned.Add(a.IdentifierToken.Text);
                break;
            case MultiAssignmentStatementSyntax m:
                foreach (var t in m.Targets)
                {
                    if (t is NameExpressionSyntax ne)
                    {
                        assigned.Add(ne.IdentifierToken.Text);
                    }
                }

                break;
        }

        foreach (var child in node.GetChildren())
        {
            mayMutateMemberPaths |= CollectAssignedNamesAndMemberMutation(child, assigned);
        }

        return mayMutateMemberPaths;
    }

    /// <summary>
    /// ADR-0069 / issue #700: when the bound statement is an
    /// <see cref="BoundIfStatement"/> whose then-branch unconditionally
    /// exits the enclosing block, and whose else-frame (recorded by
    /// <see cref="BindIfStatement"/>) is non-empty, merge that frame into
    /// <paramref name="persistentFrame"/> so subsequent statements in the
    /// enclosing block see the narrowing.
    /// </summary>
    private void ApplyEarlyExitNarrowings(BoundStatement statement, Dictionary<AccessPath, TypeSymbol> persistentFrame)
    {
        if (statement is BoundIfStatement ifStmt)
        {
            if (!binderCtx.PendingEarlyExitFrames.TryGetValue(ifStmt, out var elseFrame))
            {
                return;
            }

            binderCtx.PendingEarlyExitFrames.Remove(ifStmt);

            // Only apply the lift if the then-branch unconditionally exits.
            // Falling through means the variable could still be of any type
            // that satisfies the original condition, so the else-frame is not
            // a safe post-condition.
            if (!EndsInUnconditionalExit(ifStmt.ThenStatement))
            {
                return;
            }

            foreach (var kv in elseFrame)
            {
                persistentFrame[kv.Key] = kv.Value;
            }

            return;
        }

        // ADR-0069 addendum / issue #712: post-switch narrowing lift. When
        // every non-exiting arm contributes the same narrowing on the
        // discriminator, propagate that narrowing into the enclosing block.
        if (statement is BoundPatternSwitchStatement switchStmt
            && binderCtx.PendingSwitchExitFrames.TryGetValue(switchStmt, out var switchFrame))
        {
            binderCtx.PendingSwitchExitFrames.Remove(switchStmt);

            foreach (var kv in switchFrame)
            {
                persistentFrame[kv.Key] = kv.Value;
            }
        }
    }

    /// <summary>
    /// Issue #1123: assignment-based smart cast. When the bound statement is a
    /// plain <c>x = rhs</c> assignment whose target is a nullable <c>var</c>
    /// local and whose right-hand side is statically a <em>non-nullable</em>
    /// value assignable to the local's underlying type, record a narrowing of
    /// <c>x</c> to that underlying non-nullable type in
    /// <paramref name="persistentFrame"/>. Mirrors the post-guard narrowing of
    /// <see cref="ApplyEarlyExitNarrowings"/>: the entry persists for the rest
    /// of the enclosing block (and into nested blocks) until
    /// <see cref="InvalidateNarrowingsForAssignedVariables"/> clears it on a
    /// subsequent mutation. Called after invalidation so the fresh narrowing
    /// supersedes the clearing pass for this same statement.
    /// </summary>
    private void ApplyAssignmentNarrowing(BoundStatement statement, Dictionary<AccessPath, TypeSymbol> persistentFrame)
    {
        if (statement is BoundExpressionStatement { Expression: BoundAssignmentExpression assign }
            && TryClassifyNonNullAssignment(assign, out var local, out var underlying))
        {
            persistentFrame[local] = underlying;
        }
    }

    /// <summary>
    /// Issue #1123 / issue #2159: classifies whether <paramref name="assign"/>
    /// assigns a statically <em>non-nullable</em> value to a nullable
    /// reference-like <c>var</c> local, proving the local is non-null after the
    /// assignment. Shared by <see cref="ApplyAssignmentNarrowing"/> (straight-
    /// line assignment narrowing) and the <c>if</c>-join narrowing pass (which
    /// consults it to decide whether a branch leaves the local non-null).
    /// </summary>
    /// <param name="assign">The bound assignment to classify.</param>
    /// <param name="local">On success, the narrowed local.</param>
    /// <param name="underlying">On success, the local's underlying non-nullable type.</param>
    /// <returns><see langword="true"/> when the assignment narrows the local.</returns>
    private bool TryClassifyNonNullAssignment(BoundAssignmentExpression assign, out LocalVariableSymbol local, out TypeSymbol underlying)
    {
        local = null;
        underlying = null;

        // Narrow locals only — never parameters, fields, or read-only `let`
        // locals (a `let` cannot be reassigned, so it never reaches here with a
        // re-narrowable shape anyway). This matches the receiver-stability rule
        // the type-test smart cast applies to `var` locals.
        if (assign.Variable is not LocalVariableSymbol l || l.IsReadOnly)
        {
            return false;
        }

        if (l.Type is not NullableTypeSymbol nullable)
        {
            return false;
        }

        var assignedType = assign.AssignedValueType;
        if (assignedType == null || assignedType == TypeSymbol.Error)
        {
            return false;
        }

        // A possibly-null right-hand side does not narrow (invalidation already
        // cleared any prior narrowing). Only a statically non-nullable value
        // proves the local is non-null after the assignment.
        if (assignedType is NullableTypeSymbol)
        {
            return false;
        }

        // Issue #1123 is scoped to reference (and interface) types. Nullable
        // value types (`int32?` → `int32`) are excluded: the existing narrowed-
        // read emit path does not unwrap `Nullable<T>` to its underlying value
        // for a `var`-local read, so a narrowed value-type read produces
        // unverifiable IL. Reference nullability is purely an annotation, so a
        // narrowed reference read needs no special emit.
        var u = nullable.UnderlyingType;
        if (!IsReferenceLikeType(u))
        {
            return false;
        }

        // The right-hand side must be implicitly convertible to the local's
        // underlying non-nullable type. The assignment itself already proved the
        // value converts to the nullable declared type; this guards the value
        // narrowing to the underlying type (e.g. excludes shapes where the only
        // conversion to the bare underlying type would be explicit).
        var conversion = Conversion.Classify(assignedType, u);
        if (!conversion.Exists || !conversion.IsImplicit)
        {
            return false;
        }

        local = l;
        underlying = u;
        return true;
    }

    /// <summary>
    /// Issue #2159: <c>if</c>-join narrowing. When both the then-branch and the
    /// else-branch (explicit or the implicit negated-condition else) of a
    /// fall-through <see cref="BoundIfStatement"/> leave a nullable <c>var</c>
    /// local non-null at their exit, lift that narrowing into the enclosing
    /// block's persistent frame so subsequent reads see the non-nullable type.
    /// This generalises the straight-line assignment narrowing (issue #1123)
    /// and the early-exit narrowing (issue #700) to the ubiquitous
    /// "null-check then reassign in the null branch" idiom.
    /// <para>
    /// A branch leaves the local non-null when it either (a) assigns it a
    /// statically non-null value (see <see cref="TryClassifyNonNullAssignment"/>),
    /// or (b) is entered under a condition that narrows it non-null
    /// (<c>x != nil</c>) and never reassigns it to a nullable value. The result
    /// is the intersection over the two branch exits, so the local is narrowed
    /// only when proven non-null on every path that reaches the join.
    /// </para>
    /// Runs after <see cref="InvalidateNarrowingsForAssignedVariables"/> (which
    /// clears any stale narrowing on variables the <c>if</c> mutates) so the
    /// fresh join narrowing supersedes the clearing pass; a later statement that
    /// reassigns the local to a nullable value re-nullable-izes it through its
    /// own invalidation pass.
    /// </summary>
    private void ApplyIfJoinNarrowings(BoundStatement statement, Dictionary<AccessPath, TypeSymbol> persistentFrame)
    {
        if (statement is not BoundIfStatement ifStmt)
        {
            return;
        }

        // Both branches must fall through to the join. A branch that
        // unconditionally exits (return/throw/break/continue/goto) is the
        // early-exit case handled by ApplyEarlyExitNarrowings; requiring both
        // branches to fall through here keeps the two passes from overlapping.
        if (EndsInUnconditionalExit(ifStmt.ThenStatement))
        {
            return;
        }

        if (ifStmt.ElseStatement != null && EndsInUnconditionalExit(ifStmt.ElseStatement))
        {
            return;
        }

        var joined = ComputeIfJoinNonNull(ifStmt, entry: null);
        if (joined == null || joined.Count == 0)
        {
            return;
        }

        foreach (var kv in joined)
        {
            var path = kv.Key;

            // Lift plain nullable reference-like `var` locals only, matching the
            // scope of the straight-line assignment narrowing. Value-type
            // nullables and member paths are intentionally excluded.
            if (path.HasMembers
                || path.Root is not LocalVariableSymbol local
                || local.IsReadOnly
                || local.Type is not NullableTypeSymbol nullable
                || !IsReferenceLikeType(nullable.UnderlyingType))
            {
                continue;
            }

            persistentFrame[path] = nullable.UnderlyingType;
        }
    }

    /// <summary>
    /// Issue #2159: computes the set of locals proven non-null at the normal
    /// (fall-through) exit of <paramref name="ifStmt"/>, given the non-null
    /// locals on entry (<paramref name="entry"/>). Recurses through
    /// <c>else if</c> chains (an <c>else if</c> is a nested
    /// <see cref="BoundIfStatement"/>). Returns <see langword="null"/> when the
    /// whole <c>if</c> exits unconditionally (no path falls through).
    /// </summary>
    private Dictionary<AccessPath, TypeSymbol> ComputeIfJoinNonNull(BoundIfStatement ifStmt, Dictionary<AccessPath, TypeSymbol> entry)
    {
        var (thenNarrow, elseNarrow) = ComputeConditionNarrowing(ifStmt.Condition);

        var thenState = ComputeBranchFallthroughNonNull(ifStmt.ThenStatement, MergeLocalNonNull(entry, thenNarrow));

        var elseState = ifStmt.ElseStatement == null

            // Implicit else: no statements run, so the only non-null facts are
            // the entry set plus whatever the negated condition narrows.
            ? MergeLocalNonNull(entry, elseNarrow)
            : ComputeBranchFallthroughNonNull(ifStmt.ElseStatement, MergeLocalNonNull(entry, elseNarrow));

        if (thenState == null && elseState == null)
        {
            return null;
        }

        // When one branch exits, the join is reached only through the other, so
        // that branch's non-null set holds unconditionally at the join.
        if (thenState == null)
        {
            return elseState;
        }

        if (elseState == null)
        {
            return thenState;
        }

        return IntersectNonNull(thenState, elseState);
    }

    /// <summary>
    /// Issue #2159: computes the locals proven non-null at the normal exit of a
    /// single branch <paramref name="branch"/>, seeded with the non-null locals
    /// on entry. Returns <see langword="null"/> when the branch unconditionally
    /// exits (does not fall through to the join).
    /// </summary>
    private Dictionary<AccessPath, TypeSymbol> ComputeBranchFallthroughNonNull(BoundStatement branch, Dictionary<AccessPath, TypeSymbol> entry)
    {
        switch (branch)
        {
            case BoundReturnStatement:
            case BoundThrowStatement:
            case BoundGotoStatement:
                return null;

            case BoundIfStatement nested:
                return ComputeIfJoinNonNull(nested, entry);

            case BoundBlockStatement block:
                {
                    var state = entry ?? new Dictionary<AccessPath, TypeSymbol>();
                    if (block.Statements.IsDefaultOrEmpty)
                    {
                        return state;
                    }

                    foreach (var s in block.Statements)
                    {
                        if (!ProcessBranchStatement(s, state))
                        {
                            return null;
                        }
                    }

                    return state;
                }

            default:
                {
                    var state = entry ?? new Dictionary<AccessPath, TypeSymbol>();
                    return ProcessBranchStatement(branch, state) ? state : null;
                }
        }
    }

    /// <summary>
    /// Issue #2159: folds a single branch statement into the running non-null
    /// <paramref name="state"/>. Returns <see langword="false"/> when the
    /// statement unconditionally exits the branch (so later statements are
    /// unreachable).
    /// </summary>
    private bool ProcessBranchStatement(BoundStatement stmt, Dictionary<AccessPath, TypeSymbol> state)
    {
        switch (stmt)
        {
            case BoundReturnStatement:
            case BoundThrowStatement:
            case BoundGotoStatement:
                return false;

            case BoundExpressionStatement { Expression: BoundAssignmentExpression assign }:
                if (TryClassifyNonNullAssignment(assign, out var local, out var underlying))
                {
                    state[AccessPath.ForVariable(local)] = underlying;
                }
                else if (assign.Variable != null)
                {
                    // Any other assignment to a tracked local (nullable value,
                    // value type, …) drops its narrowing.
                    RemoveByRoot(state, assign.Variable);
                }

                return true;

            case BoundIfStatement nested:
                {
                    // The nested join is the exact post-if non-null set given the
                    // current state as entry, so it fully replaces the tracked
                    // state (it carries surviving entry facts through).
                    var nestedResult = ComputeIfJoinNonNull(nested, new Dictionary<AccessPath, TypeSymbol>(state));
                    if (nestedResult == null)
                    {
                        return false;
                    }

                    state.Clear();
                    foreach (var kv in nestedResult)
                    {
                        state[kv.Key] = kv.Value;
                    }

                    return true;
                }

            case BoundBlockStatement inner:
                foreach (var s in inner.Statements)
                {
                    if (!ProcessBranchStatement(s, state))
                    {
                        return false;
                    }
                }

                return true;

            default:
                // Loops, switches, and any other construct that could reassign a
                // tracked local: conservatively drop every narrowing on a local
                // the statement's subtree assigns anywhere.
                ClearAssignedRoots(stmt, state);
                return true;
        }
    }

    /// <summary>
    /// Issue #2159: recomputes the then / else condition-implied non-null
    /// narrowing frames for an <c>if</c> condition, mirroring the composition
    /// <see cref="BindIfStatement"/> performs (nil guard, <c>[NotNullWhen]</c>
    /// bool call, and type-test), so the join analysis sees the same seeds the
    /// branches were bound under.
    /// </summary>
    private (Dictionary<AccessPath, TypeSymbol> Then, Dictionary<AccessPath, TypeSymbol> Else) ComputeConditionNarrowing(BoundExpression condition)
    {
        var (thenNarrow, elseNarrow) = TryClassifyNilGuard(condition);
        if (thenNarrow == null && elseNarrow == null)
        {
            (thenNarrow, elseNarrow) = TryClassifyBoolCallNarrowing(condition);
        }

        var (typeThen, typeElse) = TryClassifyTypeTestNarrowing(condition);
        thenNarrow = MergeNarrowingFrames(thenNarrow, typeThen);
        elseNarrow = MergeNarrowingFrames(elseNarrow, typeElse);
        return (thenNarrow, elseNarrow);
    }

    /// <summary>
    /// Issue #2159: returns a fresh dictionary combining <paramref name="baseState"/>
    /// with the plain-local entries of <paramref name="add"/> (a
    /// condition-narrowing frame). Only plain-variable paths rooted at a local
    /// are kept — parameters and member paths are outside the join pass's lift
    /// scope.
    /// </summary>
    private static Dictionary<AccessPath, TypeSymbol> MergeLocalNonNull(Dictionary<AccessPath, TypeSymbol> baseState, Dictionary<AccessPath, TypeSymbol> add)
    {
        var result = baseState == null
            ? new Dictionary<AccessPath, TypeSymbol>()
            : new Dictionary<AccessPath, TypeSymbol>(baseState);

        if (add != null)
        {
            foreach (var kv in add)
            {
                if (!kv.Key.HasMembers && kv.Key.Root is LocalVariableSymbol)
                {
                    result[kv.Key] = kv.Value;
                }
            }
        }

        return result;
    }

    /// <summary>
    /// Issue #2159: intersects two branch-exit non-null maps, keeping a local
    /// only when both branches prove it non-null with the same underlying type.
    /// </summary>
    private static Dictionary<AccessPath, TypeSymbol> IntersectNonNull(Dictionary<AccessPath, TypeSymbol> a, Dictionary<AccessPath, TypeSymbol> b)
    {
        var result = new Dictionary<AccessPath, TypeSymbol>();
        foreach (var kv in a)
        {
            if (b.TryGetValue(kv.Key, out var other) && Equals(other, kv.Value))
            {
                result[kv.Key] = kv.Value;
            }
        }

        return result;
    }

    /// <summary>
    /// Issue #2159: removes every narrowing whose access path is rooted at
    /// <paramref name="root"/> from <paramref name="state"/>.
    /// </summary>
    private static void RemoveByRoot(Dictionary<AccessPath, TypeSymbol> state, VariableSymbol root)
    {
        List<AccessPath> toRemove = null;
        foreach (var key in state.Keys)
        {
            if (ReferenceEquals(key.Root, root))
            {
                (toRemove ??= new List<AccessPath>()).Add(key);
            }
        }

        if (toRemove != null)
        {
            foreach (var key in toRemove)
            {
                state.Remove(key);
            }
        }
    }

    /// <summary>
    /// Issue #2159: conservatively drops every narrowing on a local that
    /// <paramref name="node"/>'s bound subtree assigns anywhere.
    /// </summary>
    private static void ClearAssignedRoots(BoundNode node, Dictionary<AccessPath, TypeSymbol> state)
    {
        if (state.Count == 0)
        {
            return;
        }

        var collector = new AssignedRootsCollector();
        collector.Visit(node);
        foreach (var root in collector.Roots)
        {
            RemoveByRoot(state, root);
        }
    }

    /// <summary>
    /// Issue #2159: bound-tree walker collecting the root variable of every
    /// plain assignment target in a subtree, used to conservatively invalidate
    /// join narrowings across constructs the flow analysis does not model.
    /// </summary>
    private sealed class AssignedRootsCollector : BoundTreeWalker
    {
        public HashSet<VariableSymbol> Roots { get; } = new HashSet<VariableSymbol>();

        protected override void VisitAssignmentExpression(BoundAssignmentExpression node)
        {
            if (node.Variable != null)
            {
                Roots.Add(node.Variable);
            }

            base.VisitAssignmentExpression(node);
        }
    }

    /// <summary>
    /// Issue #1123: whether <paramref name="type"/> is a reference-like type —
    /// an interface, a user class, or a CLR-backed class/interface. User value
    /// structs (null <c>ClrType</c> during binding, <c>IsClass == false</c>)
    /// and CLR value types / pointers / by-refs are excluded. Mirrors the
    /// reference-likeness rule the conversion classifier uses for nullable
    /// reference targets.
    /// </summary>
    private static bool IsReferenceLikeType(TypeSymbol type)
    {
        if (type is InterfaceSymbol)
        {
            return true;
        }

        if (type is StructSymbol structSymbol)
        {
            return structSymbol.IsClass;
        }

        // Issue #2159: a type parameter constrained to a reference type
        // (`class`) or a reference base class is a reference type at the CLR
        // level, so `T?` → `T` is a metadata-only narrowing that emits a
        // verifiable read — matching the reference-nullable case above.
        if (type is TypeParameterSymbol typeParameter)
        {
            return typeParameter.HasReferenceTypeConstraint || typeParameter.ClassConstraint != null;
        }

        if (type?.ClrType is { } clrBacking)
        {
            return !clrBacking.IsValueType && !clrBacking.IsPointer && !clrBacking.IsByRef;
        }

        return false;
    }

    /// <summary>
    /// ADR-0069 / issue #700: structurally determine whether the given
    /// bound statement unconditionally transfers control out of its
    /// enclosing block (return / throw / unconditional goto, which covers
    /// the lowered shapes of <c>break</c> and <c>continue</c>). A block
    /// counts when its last statement does any of those; an
    /// <see cref="BoundIfStatement"/> counts only if both arms do.
    /// </summary>
    private static bool EndsInUnconditionalExit(BoundStatement statement)
    {
        switch (statement)
        {
            case BoundReturnStatement:
            case BoundThrowStatement:
                return true;

            case BoundGotoStatement:
                // `break`/`continue` lower to BoundGotoStatement before this
                // helper runs; an explicit `goto` likewise transfers
                // control unconditionally.
                return true;

            case BoundBlockStatement block:
                if (block.Statements.IsDefaultOrEmpty)
                {
                    return false;
                }

                return EndsInUnconditionalExit(block.Statements[block.Statements.Length - 1]);

            case BoundIfStatement nested:
                if (nested.ElseStatement == null)
                {
                    return false;
                }

                return EndsInUnconditionalExit(nested.ThenStatement)
                    && EndsInUnconditionalExit(nested.ElseStatement);

            case BoundPatternSwitchStatement nestedSwitch:
                {
                    // ADR-0069 addendum / issue #712: a switch unconditionally
                    // exits when every arm (including default) does, and it
                    // covers every input the discriminator can take — i.e.,
                    // a default arm exists. Without a default the switch
                    // can fall through past every arm without entering any.
                    var hasDefault = false;
                    foreach (var arm in nestedSwitch.Arms)
                    {
                        if (arm.Pattern == null || arm.Pattern is BoundDiscardPattern)
                        {
                            hasDefault = true;
                        }

                        if (!EndsInUnconditionalExit(arm.Body))
                        {
                            return false;
                        }
                    }

                    return hasDefault;
                }

            default:
                return false;
        }
    }

    /// <summary>
    /// Issue #1480: returns <see langword="true"/> when the expression is a
    /// null-coalescing (<c>??</c>) binary expression. Such expressions honor the
    /// contextual target type in target-typed positions (typed local, return,
    /// assignment, argument) so sibling operands can unify to a common interface
    /// or base class supplied by the consumer.
    /// </summary>
    /// <param name="syntax">The candidate expression syntax.</param>
    /// <returns><see langword="true"/> for a <c>??</c> binary expression.</returns>
    private static bool IsNullCoalescingExpression(ExpressionSyntax syntax)
        => syntax is BinaryExpressionSyntax binary
            && binary.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken;

    private BoundStatement BindVariableDeclaration(VariableDeclarationSyntax syntax)
    {
        // Issue #491 (ADR-0060 follow-up): a `let ref` / `var ref` declaration introduces a
        // ref-aliasing local. The local's IL slot stores a managed pointer (`T&`) into the
        // initializer's lvalue; the symbol's static type remains `T` and reads/writes through
        // the local are implicitly indirected by the lowering & emitter. The slot itself
        // never carries a `const` value, so the assignability of the alias matches the
        // mutability of the aliased lvalue (writes through the alias write the storage).
        if (syntax.HasRefKindModifier)
        {
            return BindRefAliasLocalDeclaration(syntax);
        }

        // Issue #1886: `let Name[T, ...] = func (...) ... { ... }` declares a generic local
        // function. Route to the dedicated LambdaBinder path instead of the ordinary
        // variable-declaration binder — a generic function value cannot be represented as a
        // delegate stored in a variable.
        if (syntax.TypeParameterList != null)
        {
            return bindGenericLocalFunctionDeclaration != null
                ? bindGenericLocalFunctionDeclaration(syntax)
                : throw new InvalidOperationException("Generic local-function declarations require bindGenericLocalFunctionDeclaration to be wired.");
        }

        var isReadOnly = syntax.Keyword?.Kind == SyntaxKind.ConstKeyword
            || syntax.Keyword?.Kind == SyntaxKind.LetKeyword;
        var type = bindTypeClause(syntax.TypeClause);

        BoundExpression convertedInitializer;
        TypeSymbol variableType;
        if (syntax.Initializer == null)
        {
            // Bare `var x T` declaration: the variable is initialized to the
            // type's default value (Go-style zero value). The parser only
            // produces a null initializer when a type clause is present.
            variableType = type ?? TypeSymbol.Error;
            convertedInitializer = new BoundDefaultExpression(syntax, variableType);
        }
        else
        {
            // ADR-0055 Tier 4: an interpolated-string initializer whose declared
            // type is IFormattable/FormattableString lowers to
            // FormattableStringFactory.Create rather than an eager string.
            if (type != null
                && syntax.Initializer is InterpolatedStringExpressionSyntax interpolatedInit
                && isFormattableStringTargetType(type))
            {
                variableType = type;
                convertedInitializer = bindInterpolatedStringAsFormattable(interpolatedInit, type);
            }
            else if (type != null
                && syntax.Initializer is LambdaExpressionSyntax targetTypedLambda
                && bindLambdaWithTargetType != null
                && MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(type, out var targetFnType))
            {
                // ADR-0076 / issue #716: when a binding has an explicit
                // function-type and is initialised with an arrow lambda,
                // bind the lambda with the target shape so omitted
                // parameter type clauses are filled in from the target's
                // slots. The conversion that follows is identity for a
                // matching lambda shape; for a mismatch the regular
                // conversion diagnostic still fires.
                //
                // Issue #951: the target shape is extracted via
                // TryGetDelegateFunctionTypeFromSymbol so it also covers an
                // explicit CLR delegate binding type (e.g.
                // `let f Func[int32, int32] = (x) -> x + 1`), not just the
                // canonical `(int32) -> int32` function-type clause.
                variableType = type;
                var lambda = bindLambdaWithTargetType(targetTypedLambda, targetFnType);
                convertedInitializer = conversions.BindConversion(syntax.Initializer.Location, lambda, variableType);
            }
            else if (type is PointerTypeSymbol && syntax.Initializer is StackAllocExpressionSyntax)
            {
                // ADR-0124 / issue #1024: `var p *T = stackalloc [n]T` inside
                // an unsafe context yields the raw `T*` pointer. The target
                // pointer type must be threaded into the stackalloc binder so
                // it selects the pointer form rather than the default Span<T>.
                variableType = type;
                convertedInitializer = bindExpressionWithTargetType(syntax.Initializer, type);
            }
            else if (type != null && syntax.Initializer is DefaultExpressionSyntax defaultInit && defaultInit.TypeClause == null)
            {
                // ADR-0100 / issue #795: bare `default` initializer takes
                // its type from the declared variable type. We bind to a
                // BoundDefaultExpression of that type directly so the
                // emitter sees the value-type zero-init shape and the
                // interpreter mirrors it. The eager
                // `bindExpression(syntax.Initializer)` path would report
                // GS0362 because the kind dispatch has no target type.
                variableType = type;
                convertedInitializer = new BoundDefaultExpression(defaultInit, variableType);
            }
            else if (type != null
                && (syntax.Initializer is IfExpressionSyntax
                    || syntax.Initializer is ConditionalExpressionSyntax
                    || syntax.Initializer is SwitchExpressionSyntax
                    || IsNullCoalescingExpression(syntax.Initializer)))
            {
                // Issue #1158: when a typed local is initialised with an
                // if-/conditional-/switch-expression, thread the declared type
                // into the binder as the target type so sibling arms can unify
                // to it (C# 9+ target-typed conditional/switch), including a
                // target that is wider than the arms' natural least-upper-bound
                // (e.g. `object` or a shared interface). The conversion below is
                // identity for the chosen target; a genuine mismatch still
                // reports the regular conversion diagnostic.
                variableType = type;
                var initializer = bindExpressionWithTargetType(syntax.Initializer, type);
                convertedInitializer = conversions.BindConversion(syntax.Initializer.Location, initializer, variableType);
            }
            else
            {
                var initializer = bindExpression(syntax.Initializer);
                variableType = type ?? initializer.Type;
                convertedInitializer = conversions.BindConversion(syntax.Initializer.Location, initializer, variableType);

                // Issue #2016: a NON-generic named local function (`let`/`var`/`const
                // Name = func (...) ... {...}`, no `[T, ...]` of its own — the sibling
                // case of #1940's generic local function) that directly references an
                // enclosing type parameter in its own parameter/return type or body
                // can silently emit invalid IL. Check the just-bound literal now,
                // while it's still available with its identifier's name/location.
                //
                // Follow-up review of #2024: the original gate here required
                // `syntax.Keyword?.Kind == SyntaxKind.LetKeyword`, which let a `var`-
                // declared local function of the exact same zero-capture shape sail
                // through uncaught (the emitter's hoisting path doesn't distinguish
                // let/var/const — only "is this a function-literal initializer").
                // The check now keys off the bound initializer's kind
                // (BoundFunctionLiteralExpression) rather than the declaring keyword,
                // so it fires uniformly for `let`, `var`, and `const` forms.
                if (initializer is BoundFunctionLiteralExpression functionLiteral
                    && checkNonGenericLocalFunctionEnclosingTypeParameterReference != null)
                {
                    checkNonGenericLocalFunctionEnclosingTypeParameterReference(syntax.Identifier.Location, syntax.Identifier.Text, functionLiteral);
                }
            }
        }

        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);
        var variable = bindLocalVariableWithAccessibility(syntax.Identifier, isReadOnly, variableType, accessibility);

        // ADR-0058 / issue #376: propagate `scoped` modifier from syntax to the local symbol,
        // or infer function-local escape scope from the initializer (STE data-flow propagation).
        if (variable is LocalVariableSymbol localVar)
        {
            if (syntax.IsScoped)
            {
                localVar.IsScoped = true;
            }
            else if ((TypeSymbol.IsByRefLike(variableType) || variableType is ByRefTypeSymbol) && convertedInitializer != null)
            {
                // Infer scoped from initializer: if the initializer is rooted in a
                // scoped variable, the new local inherits function-local STE/RSTE.
                localVar.IsScoped = HasFunctionLocalEscapeScope(convertedInitializer);
            }
        }

        // Issue #367: a by-ref-like (`ref struct`) local is legal in an ordinary
        // function, but an iterator hoists every local into a heap-allocated
        // state machine, which the CLR forbids for a by-ref-like type. A
        // top-level (global) variable is emitted as a static field, which is
        // likewise heap-rooted and forbidden. Reject the declaration in those
        // contexts.
        //
        // Issue #2350: an async function's state machine also hoists locals,
        // but — unlike an iterator — it is legal for a by-ref-like local to
        // appear there as long as it never needs to survive an `await`
        // suspension point (the CLR forbids a by-ref-like *field*, but the
        // async lowering already never hoists such a local into one — see
        // AsyncCaptureWalker — so it is only unsafe when live across a
        // suspension). That is a per-local dataflow question this syntax-only
        // check cannot answer, so the coarse "any by-ref-like local in any
        // async function" rejection that used to live here has been replaced
        // by RefStructAsyncLivenessAnalyzer, which runs after lowering (see
        // its call sites in Binder.cs) and reports ReportByRefLikeEscape only
        // for a local actually proven live across a suspension (including via
        // unsafe try/finally interaction).
        if (TypeSymbol.IsByRefLike(variableType))
        {
            if (function == null || function.IsTopLevelEntryPoint)
            {
                Diagnostics.ReportByRefLikeEscape(syntax.Identifier.Location, variableType, "be declared as a top-level variable (it would be emitted as a heap-rooted static field)");
            }
            else if (!function.IsAsync && isIteratorReturnType(function.Type))
            {
                Diagnostics.ReportByRefLikeEscape(syntax.Identifier.Location, variableType, "be declared as a local in an iterator (it would be hoisted into the state machine)");
            }
        }

        // Issue #187 / ADR-0047 §3: bind any `@Foo` annotations and attach
        // them to the variable symbol so #175 use-site diagnostics
        // (e.g. `@Obsolete`) fire when the variable is read or written.
        // Globals (`GlobalVariableSymbol`) will eventually round-trip these
        // to CLR `CustomAttribute` rows on their backing static field; for
        // locals the attributes carry compiler-recognised semantics only.
        if (variable != null && !syntax.Annotations.IsDefaultOrEmpty)
        {
            var positionDescription = variable is GlobalVariableSymbol
                ? "a top-level variable declaration"
                : "a local variable declaration";
            var boundAttrs = bindVariableDeclarationAttributes(syntax.Annotations, positionDescription);
            variable.SetAttributes(boundAttrs);
        }

        // Issue #216: a `const` declaration whose converted initializer is a
        // literal expression carries a compile-time ConstantValue. The emitter
        // uses this to skip IL slot allocation and emit a LocalConstant PDB row.
        object constValue = null;
        if (syntax.Keyword?.Kind == SyntaxKind.ConstKeyword
            && convertedInitializer is BoundLiteralExpression litExpr)
        {
            constValue = litExpr.Value;
        }

        return new BoundVariableDeclaration(syntax, variable, convertedInitializer, constValue);
    }

    /// <summary>
    /// Issue #491 (ADR-0060 follow-up): binds a <c>let ref name [T] = lvalue</c> or
    /// <c>var ref name [T] = lvalue</c> declaration. The local is recorded with
    /// <see cref="RefKind.Ref"/> and its initializer is normalized to a
    /// <see cref="BoundAddressOfExpression"/> over the aliased lvalue so the emitter / interpreter
    /// can populate the alias slot with a managed pointer at the declaration site and
    /// route subsequent reads/writes through the indirection.
    /// </summary>
    private BoundStatement BindRefAliasLocalDeclaration(VariableDeclarationSyntax syntax)
    {
        var refModifierLoc = syntax.RefKindModifier.Location;
        var declaredType = bindTypeClause(syntax.TypeClause);

        // `const ref` is rejected: a `const` binding is a compile-time constant,
        // not a runtime storage slot, so there is no storage to alias.
        if (syntax.Keyword?.Kind == SyntaxKind.ConstKeyword)
        {
            Diagnostics.ReportRefLocalCannotBeDeclaredHere(refModifierLoc, syntax.Identifier.Text, "a 'const' binding");
        }

        // An initializer is required: the local must alias an existing lvalue.
        if (syntax.Initializer == null)
        {
            Diagnostics.ReportRefLocalRhsMustBeLvalue(refModifierLoc, "<missing>");
            var errorVar = bindLocalVariableWithAccessibility(syntax.Identifier, isReadOnly: false, declaredType ?? TypeSymbol.Error, resolveAccessibility(syntax.AccessibilityModifier));
            return new BoundVariableDeclaration(syntax, errorVar, new BoundErrorExpression(null));
        }

        var initializer = bindExpression(syntax.Initializer);
        if (initializer is BoundErrorExpression)
        {
            var errorVar = bindLocalVariableWithAccessibility(syntax.Identifier, isReadOnly: false, declaredType ?? TypeSymbol.Error, resolveAccessibility(syntax.AccessibilityModifier));
            return new BoundVariableDeclaration(syntax, errorVar, initializer);
        }

        // Validate the RHS is a writable lvalue: a variable that is not read-only,
        // a field/property access, an indexer access, or a managed-pointer dereference.
        // The same restrictions that govern `&expr` apply here (issue #491 / ADR-0039 §3).
        var rhsValid = true;
        if (initializer is BoundVariableExpression bve && bve.Variable.IsReadOnly)
        {
            // Aliasing a read-only binding would let the alias mutate it; mirror
            // the existing `&readonly` rejection (GS9005 / GS0242 for `in`).
            if (bve.Variable is ParameterSymbol inParam && inParam.RefKind == RefKind.In)
            {
                Diagnostics.ReportCannotAssignToInParameter(refModifierLoc, inParam.Name);
            }
            else
            {
                Diagnostics.ReportCannotTakeAddressOfConstant(refModifierLoc, bve.Variable.Name);
            }

            rhsValid = false;
        }
        else if (!isLvalue(initializer))
        {
            var exprText = syntax.Initializer.ToString();
            Diagnostics.ReportRefLocalRhsMustBeLvalue(refModifierLoc, exprText);
            rhsValid = false;
        }

        // Pointee type: the user may write an explicit type clause that must match
        // the initializer's static type; otherwise infer from the initializer.
        var pointeeType = initializer.Type ?? TypeSymbol.Error;
        if (declaredType != null && rhsValid && pointeeType != TypeSymbol.Error && declaredType != pointeeType)
        {
            Diagnostics.ReportCannotConvert(syntax.Initializer.Location, pointeeType, declaredType);
            rhsValid = false;
        }

        var slotType = declaredType ?? pointeeType;

        // Context restrictions: a ref-aliasing local cannot escape its declaring
        // function frame. The CLR cannot encode a managed pointer as a static
        // field (top-level / `customize` partial) or as a hoisted state-machine
        // field (`async`/iterator functions).
        if (function == null || function.IsTopLevelEntryPoint)
        {
            Diagnostics.ReportRefLocalCannotBeDeclaredHere(refModifierLoc, syntax.Identifier.Text, "a top-level variable (it would be emitted as a heap-rooted static field)");
            rhsValid = false;
        }
        else if (function.IsAsync || isIteratorReturnType(function.Type))
        {
            var context = function.IsAsync ? "a local in an async function" : "a local in an iterator";
            Diagnostics.ReportRefLocalCannotBeDeclaredHere(refModifierLoc, syntax.Identifier.Text, context + " (it would be hoisted into the state machine)");
            rhsValid = false;
        }

        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);
        var variable = bindLocalVariableWithAccessibility(syntax.Identifier, isReadOnly: false, slotType, accessibility);
        if (variable is LocalVariableSymbol localVar)
        {
            // The alias slot itself is function-local; never returnable.
            localVar.RefKind = RefKind.Ref;
            localVar.IsScoped = true;
        }

        // Annotations attach to the symbol unchanged (e.g. @Obsolete on a top-level
        // alias would still be observed if it ever became legal at top level).
        if (variable != null && !syntax.Annotations.IsDefaultOrEmpty)
        {
            var positionDescription = "a local variable declaration";
            var boundAttrs = bindVariableDeclarationAttributes(syntax.Annotations, positionDescription);
            variable.SetAttributes(boundAttrs);
        }

        // Lower the initializer to BoundAddressOfExpression so the emitter
        // populates the alias slot with the managed pointer (§5 / §6 of ADR-0060).
        BoundExpression boundInitializer = rhsValid
            ? new BoundAddressOfExpression(syntax.Initializer, initializer)
            : new BoundErrorExpression(null);

        return new BoundVariableDeclaration(syntax, variable, boundInitializer);
    }

    private BoundStatement BindTupleDeconstructionStatement(TupleDeconstructionStatementSyntax syntax)
    {
        // Phase 4.5: `let (a, b, ...) = expr`. Phase 7.3 extends the RHS from
        // tuple-only to data structs, preserving single-eval via a synthetic local.
        var initializer = bindExpression(syntax.Initializer);
        if (initializer.Type == TypeSymbol.Error)
        {
            return new BoundExpressionStatement(syntax, initializer);
        }

        if (initializer.Type is TupleTypeSymbol tupleType)
        {
            if (syntax.Identifiers.Count != tupleType.Arity)
            {
                Diagnostics.ReportDeconstructionFieldCountMismatch(syntax.CloseParenToken.Location, tupleType.Arity, syntax.Identifiers.Count);
                return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
            }

            var tempName = $"<tuple{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
            var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, tupleType);
            scope.TryDeclareVariable(tempVar);

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            statements.Add(new BoundVariableDeclaration(syntax, tempVar, initializer));

            for (var i = 0; i < syntax.Identifiers.Count; i++)
            {
                var idTok = syntax.Identifiers[i];
                var elemType = tupleType.ElementTypes[i];
                var elemVar = bindLocalVariable(idTok, isReadOnly: true, elemType);
                var access = new BoundTupleElementAccessExpression(null, new BoundVariableExpression(null, tempVar), tupleType, i);
                statements.Add(new BoundVariableDeclaration(syntax, elemVar, access));
            }

            return new BoundBlockStatement(syntax, statements.ToImmutable());
        }

        if (initializer.Type is StructSymbol structType && (structType.IsData || structType.IsInline))
        {
            var fields = structType.Fields;
            if (syntax.Identifiers.Count != fields.Length)
            {
                Diagnostics.ReportDeconstructionFieldCountMismatch(syntax.CloseParenToken.Location, fields.Length, syntax.Identifiers.Count);
                return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
            }

            var tempName = $"<data{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
            var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, structType);
            scope.TryDeclareVariable(tempVar);

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            statements.Add(new BoundVariableDeclaration(syntax, tempVar, initializer));
            for (var i = 0; i < syntax.Identifiers.Count; i++)
            {
                var idTok = syntax.Identifiers[i];
                var field = fields[i];
                var elemVar = bindLocalVariable(idTok, isReadOnly: true, field.Type);
                var access = new BoundFieldAccessExpression(null, new BoundVariableExpression(null, tempVar), structType, field);
                statements.Add(new BoundVariableDeclaration(syntax, elemVar, access));
            }

            return new BoundBlockStatement(syntax, statements.ToImmutable());
        }

        Diagnostics.ReportDeconstructionRequiresTupleOrDataStruct(syntax.OpenParenToken.Location, initializer.Type);
        return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
    }

    /// <summary>
    /// Issue #1922: the <c>for (a, b) in coll { ... }</c> loop-prelude hook
    /// passed to <see cref="BindForRangeStatementCore"/>. Declares one
    /// read-only local per identifier (visible to the loop body, matching
    /// <see cref="BindTupleDeconstructionStatement"/>'s tuple/data-struct
    /// handling) and returns the field-extraction statements to prepend —
    /// reading each element straight off <paramref name="elementVariable"/>
    /// instead of a redundant synthetic temp, since the loop variable already
    /// is one.
    /// </summary>
    /// <param name="identifiers">The parenthesized loop-target identifiers.</param>
    /// <param name="closeParenLocation">Location used for an arity-mismatch diagnostic.</param>
    /// <param name="openParenLocation">Location used for a wrong-shape-initializer diagnostic.</param>
    /// <param name="elementVariable">The already-declared, single, hidden loop variable.</param>
    /// <returns>The bound field-extraction statements, or empty on error (identifiers still get error-typed locals so the body doesn't cascade "undefined variable" diagnostics).</returns>
    private ImmutableArray<BoundStatement> BindForTupleLoopPrelude(
        SeparatedSyntaxList<SyntaxToken> identifiers,
        TextLocation closeParenLocation,
        TextLocation openParenLocation,
        VariableSymbol elementVariable)
    {
        var elementType = elementVariable.Type;
        var elementAccessBase = new BoundVariableExpression(null, elementVariable);

        if (elementType is TupleTypeSymbol tupleType)
        {
            if (identifiers.Count != tupleType.Arity)
            {
                Diagnostics.ReportDeconstructionFieldCountMismatch(closeParenLocation, tupleType.Arity, identifiers.Count);
                DeclareErrorTypedLocals(identifiers);
                return ImmutableArray<BoundStatement>.Empty;
            }

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            for (var i = 0; i < identifiers.Count; i++)
            {
                var elemType = tupleType.ElementTypes[i];
                var elemVar = bindLocalVariable(identifiers[i], isReadOnly: true, elemType);
                var access = new BoundTupleElementAccessExpression(null, elementAccessBase, tupleType, i);
                statements.Add(new BoundVariableDeclaration(null, elemVar, access));
            }

            return statements.ToImmutable();
        }

        if (elementType is StructSymbol structType && (structType.IsData || structType.IsInline))
        {
            var fields = structType.Fields;
            if (identifiers.Count != fields.Length)
            {
                Diagnostics.ReportDeconstructionFieldCountMismatch(closeParenLocation, fields.Length, identifiers.Count);
                DeclareErrorTypedLocals(identifiers);
                return ImmutableArray<BoundStatement>.Empty;
            }

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            for (var i = 0; i < identifiers.Count; i++)
            {
                var field = fields[i];
                var elemVar = bindLocalVariable(identifiers[i], isReadOnly: true, field.Type);
                var access = new BoundFieldAccessExpression(null, elementAccessBase, structType, field);
                statements.Add(new BoundVariableDeclaration(null, elemVar, access));
            }

            return statements.ToImmutable();
        }

        if (elementType != TypeSymbol.Error)
        {
            Diagnostics.ReportDeconstructionRequiresTupleOrDataStruct(openParenLocation, elementType);
        }

        DeclareErrorTypedLocals(identifiers);
        return ImmutableArray<BoundStatement>.Empty;
    }

    /// <summary>Declares each identifier as an error-typed local so a deconstruction failure doesn't cascade "variable doesn't exist" diagnostics through the loop body.</summary>
    private void DeclareErrorTypedLocals(SeparatedSyntaxList<SyntaxToken> identifiers)
    {
        for (var i = 0; i < identifiers.Count; i++)
        {
            bindLocalVariable(identifiers[i], isReadOnly: true, TypeSymbol.Error);
        }
    }

    private BoundStatement BindNamedDeconstructionStatement(NamedDeconstructionStatementSyntax syntax)
    {
        var initializer = bindExpression(syntax.Initializer);
        if (initializer.Type == TypeSymbol.Error)
        {
            return new BoundExpressionStatement(syntax, initializer);
        }

        if (!(initializer.Type is StructSymbol structType) || (!structType.IsData && !structType.IsInline))
        {
            Diagnostics.ReportDeconstructionRequiresTupleOrDataStruct(syntax.OpenBraceToken.Location, initializer.Type);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var tempName = $"<data{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, structType);
        scope.TryDeclareVariable(tempVar);

        var seen = new HashSet<string>();
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundVariableDeclaration(syntax, tempVar, initializer));
        foreach (var fieldSyntax in syntax.Fields)
        {
            var fieldName = fieldSyntax.FieldIdentifier.Text;
            if (!seen.Add(fieldName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            if (!TypeMemberModel.TryGetFieldIncludingInherited(structType, fieldName, MemberQuery.Instance(MemberKinds.Field), out var field, out var declaringType))
            {
                Diagnostics.ReportUnableToFindMember(fieldSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            var variable = bindLocalVariable(fieldSyntax.LocalIdentifier, isReadOnly: true, field.Type);
            var access = new BoundFieldAccessExpression(null, new BoundVariableExpression(null, tempVar), declaringType, field);
            statements.Add(new BoundVariableDeclaration(syntax, variable, access));
        }

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }
}
