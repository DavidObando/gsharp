// <copyright file="CSharpToGSharpTranslator.Types.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        private GExpression TranslateLambda(AnonymousFunctionExpressionSyntax lambda)
        {
            var parameters = new List<Parameter>();
            ParameterListSyntax parameterList = lambda switch
            {
                ParenthesizedLambdaExpressionSyntax paren => paren.ParameterList,
                AnonymousMethodExpressionSyntax anonymousMethod => anonymousMethod.ParameterList,
                _ => null,
            };

            if (lambda is SimpleLambdaExpressionSyntax simple)
            {
                parameters.Add(this.MapLambdaParameter(simple.Parameter));
            }
            else if (parameterList != null)
            {
                foreach (ParameterSyntax parameter in parameterList.Parameters)
                {
                    parameters.Add(this.MapLambdaParameter(parameter));
                }
            }
            else if (lambda is AnonymousMethodExpressionSyntax implicitParamsAnonymousMethod)
            {
                // `delegate { … }` (no parameter list at all, distinct from
                // `delegate () { … }`) binds to whatever parameter list the target
                // delegate type declares (C# spec §12.19) — the block simply may
                // not reference them. G# function literals always name params
                // explicitly, so synthesize them from the converted delegate
                // type's Invoke signature; if that type can't be resolved, this is
                // a genuine gap rather than a silent zero-arg guess.
                if (this.context.GetTypeInfo(implicitParamsAnonymousMethod).ConvertedType is INamedTypeSymbol { DelegateInvokeMethod: { } invokeMethod })
                {
                    // The body can never reference these params (C# gives them no
                    // source names here), so reusing the delegate's DECLARED param
                    // name (e.g. `Action<string>.Invoke`'s `obj`) would silently
                    // shadow an outer captured local of the same name. Keep
                    // MapParameter's type/refkind mapping but override the name
                    // with a fresh `__anon{n}` identifier C# source can't produce.
                    int index = 0;
                    foreach (IParameterSymbol invokeParameter in invokeMethod.Parameters)
                    {
                        Parameter mapped = this.MapParameter(invokeParameter, implicitParamsAnonymousMethod);
                        parameters.Add(new Parameter($"__anon{index++}", mapped.Type, mapped.IsVariadic, mapped.RefKind, mapped.DefaultValue, mapped.Attributes));
                    }
                }
                else
                {
                    this.context.ReportUnsupported(
                        implicitParamsAnonymousMethod,
                        "parameterless 'delegate { … }' anonymous method whose target delegate type could not be resolved; cannot infer its parameter list (ADR-0115 §B).");
                }
            }

            bool isAsync = lambda.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword);

            // Issue #2438: an async lambda directly targeting a VOID delegate
            // (`EventHandler h = async (s, e) => await Foo();`,
            // `button.Click += async (s, e) => { ... };`) is Roslyn's async-void
            // shape for a lambda — its inferred `IMethodSymbol.ReturnsVoid` is
            // `true` because it takes its signature from the CONVERTED target
            // delegate's `Invoke` method, not from a `Task` value of its own. It
            // needs the exact same fire-and-forget rewrite as an `async void`
            // method/local function — an ordinary `async` lambda targeting
            // `Func<Task>`/`Func<T, Task>` etc. has `ReturnsVoid == false` and is
            // untouched. See BuildAsyncVoidHandlerWrapperBody.
            bool isAsyncVoidTarget = isAsync &&
                this.context.GetSymbolInfo(lambda).Symbol is IMethodSymbol lambdaSymbol &&
                IsCSharpAsyncVoidHandler(lambdaSymbol);

            // A block-bodied lambda's body is its own evaluation scope: a spill
            // hoisted while translating it (issue #1731) must never leak into the
            // ENCLOSING statement's prologue (that would evaluate the operand
            // once, eagerly, at the lambda's definition instead of per
            // invocation). The ambient seam is suspended around the block body;
            // each statement inside it still opens its own fresh seam via
            // <see cref="TranslateStatement"/>. The assignment-/expression-bodied
            // branches below instead open their OWN fresh seam via
            // <see cref="WithSpillSeam"/> (rather than being suspended outright),
            // since they have no per-statement seam of their own to fall back on.
            List<GStatement> outerSpillPrologue = this.state.PendingSpillPrologue;
            this.state.PendingSpillPrologue = null;

            // Issue #1736: a lambda is its own mutability/reference-scan scope,
            // regardless of WHERE the lambda appears. `currentBodyScope` drives
            // `IsSymbolReassigned` (via `IsLocalReassigned`/`WithParameterShadows`),
            // which treats a null scope as "never reassigned" — correct only when
            // reached from a normal method/accessor body (already scoped by
            // <see cref="TranslateBody"/>). A lambda translated OUTSIDE any body —
            // a field/property initializer, a folded static-ctor RHS, a ctor
            // `base(...)`/`this(...)` argument, an attribute argument, etc. — left
            // `currentBodyScope` null, so a local declared and reassigned entirely
            // inside the lambda (e.g. `Func<int> f = () => { int i = 0; i++; return
            // i; };`) was misclassified as immutable and emitted `let i = 0`
            // followed by an illegal `i++`. Narrowing the scope to the lambda node
            // itself here — rather than only widening it at each out-of-body call
            // site — fixes every such position at once and is idempotent when the
            // lambda is already inside a normal body: the narrower scope is a
            // subset of the enclosing one that still contains the lambda's own
            // reassignments, so nothing that worked before regresses.
            SyntaxNode previousBodyScope = this.state.CurrentBodyScope;
            this.state.CurrentBodyScope = lambda;
            try
            {
                if (isAsyncVoidTarget)
                {
                    // Every C# lambda body shape reduces to a plain STATEMENT
                    // sequence here — never a `return`-wrapped value, even for
                    // the generic expression-bodied shape below, since a
                    // void-delegate target has no result to return (and the
                    // expression itself, e.g. a bare `await voidTask`, has no
                    // value to produce anyway).
                    BlockStatement innerBody = lambda.Body is BlockSyntax asyncVoidBlock
                        ? this.TranslateBlock(asyncVoidBlock)
                        : new BlockStatement(this.WithSpillSeam(
                            () => this.TranslateExpressionStatements((ExpressionSyntax)lambda.Body).ToList()).ToList());

                    return new LambdaExpression(
                        parameters,
                        blockBody: this.BuildAsyncVoidHandlerWrapperBody(parameters, innerBody, lambda.GetLocation()),
                        isAsync: false);
                }

                if (lambda.Body is BlockSyntax block)
                {
                    // ADR-0128 / issue #1172: a block-bodied C# lambda renders as the
                    // idiomatic G# arrow form `(params) -> { … }`. The arrow lambda's
                    // statement-block body now reaches parity with func literals and
                    // infers its return type, so no explicit return type is emitted.
                    return new LambdaExpression(
                        parameters,
                        blockBody: this.TranslateBlock(block),
                        isAsync: isAsync);
                }

                if (lambda.Body is AssignmentExpressionSyntax)
                {
                    // An assignment is statement-only in G#; an assignment-bodied lambda
                    // (`o => x = f()`) becomes a block-bodied arrow lambda. An assignment
                    // has no value, so the resulting arrow lambda is void (ADR-0128).
                    return new LambdaExpression(
                        parameters,
                        blockBody: new BlockStatement(this.WithSpillSeam(
                            () => this.TranslateExpressionStatements((ExpressionSyntax)lambda.Body).ToList()).ToList()),
                        isAsync: isAsync);
                }

                // A value-returning expression-bodied lambda (`x => x.Get() is {…}`)
                // has no statement seam of its own; open one via
                // <see cref="WithSpillSeam"/> so a nested spill (issue #1731) lands
                // here rather than being dropped. If nothing spilled, keep the
                // idiomatic arrow-expression form; otherwise the lambda must
                // become block-bodied to host the spill's `let`, ending in an
                // explicit `return`.
                var spillPrologue = new List<GStatement>();
                List<GStatement> savedSeam = this.state.PendingSpillPrologue;
                this.state.PendingSpillPrologue = spillPrologue;
                GExpression expressionBody;
                try
                {
                    expressionBody = this.TranslateExpression((ExpressionSyntax)lambda.Body);
                }
                finally
                {
                    this.state.PendingSpillPrologue = savedSeam;
                }

                if (spillPrologue.Count == 0)
                {
                    return new LambdaExpression(parameters, expressionBody: expressionBody, isAsync: isAsync);
                }

                var bodyStatements = new List<GStatement>(spillPrologue) { new ReturnStatement(expressionBody) };
                return new LambdaExpression(parameters, blockBody: new BlockStatement(bodyStatements), isAsync: isAsync);
            }
            finally
            {
                this.state.PendingSpillPrologue = outerSpillPrologue;
                this.state.CurrentBodyScope = previousBodyScope;
            }
        }

        // Shared mapping of a method/lambda result type into a G# func return type,
        // applying the `async` unwrap rule: a G# `async func` declares the UNWRAPPED
        // result, so C# `async Task` → null (void) and `async Task<T>` → `T`.
        private GTypeReference MapDelegateLikeReturnType(IMethodSymbol symbol, bool isAsync, Location location)
        {
            if (symbol.ReturnsVoid)
            {
                return null;
            }

            ITypeSymbol returnType = symbol.ReturnType;

            if (isAsync &&
                returnType is INamedTypeSymbol { Name: "Task" } task &&
                task.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks")
            {
                if (!task.IsGenericType)
                {
                    return null;
                }

                // Issue #2421: same declaration-sink promotion the sync path
                // below applies, keyed off the AWAITED type (see
                // CSharpToGSharpTranslator.MapReturnType /
                // PromoteAwaitedReturnIfTainted for the full rationale).
                ITypeSymbol awaitedType = task.TypeArguments[0];
                GTypeReference awaitedMapped = this.typeMapper.Map(awaitedType, this.context, location);
                return this.PromoteAwaitedReturnIfTainted(awaitedMapped, awaitedType, symbol);
            }

            // Issue #914 (oblivious sink): local-function/lambda return
            // promotion uses the same shared symbol-position decision as a
            // top-level method return.
            return this.PromoteReturnIfTainted(
                this.typeMapper.Map(returnType, this.context, location),
                symbol);
        }

        private Parameter MapLambdaParameter(ParameterSyntax parameter)
        {
            // A lambda parameter's type is inferred by Roslyn from the delegate
            // target even when the C# spelling omits it (`n => …`); the canonical
            // G# arrow lambda always names the parameter type (ADR-0074).
            if (this.context.GetDeclaredSymbol(parameter) is IParameterSymbol symbol)
            {
                return this.MapParameter(symbol, parameter);
            }

            GTypeReference type = parameter.Type != null
                ? this.MapTypeSyntax(parameter.Type)
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);
            return new Parameter(SanitizeIdentifier(parameter.Identifier.Text), type);
        }

        // `typeof(IEnumerable<>)` over an unbound generic has no bound symbol for
        // the omitted type argument, so the general type mapper cannot resolve it.
        // G# has no open-generic `typeof` spelling; the canonical form is the bare
        // generic definition name (`typeof(IEnumerable)`), which parses and binds
        // to the open type (issue #1915: gsc's binder now resolves a bare
        // imported generic name inside `typeof(...)` to the CLR open generic
        // definition via an arity-suffixed reflection lookup).
        // `typeof(IEnumerable<>)` over an unbound generic has no bound symbol for
        // the omitted type argument, so the general type mapper cannot resolve it.
        // Issue #2012 (S1): G# has no `Name<>`/`Name<,>` comma-count unbound-generic
        // spelling; the canonical form carries the requested arity explicitly via
        // `_` placeholder bracket type arguments (issue #1989/#2011) —
        // `typeof(IEnumerable<>)` maps to `typeof(IEnumerable[_])`,
        // `typeof(Dictionary<,>)` maps to `typeof(Dictionary[_, _])`, etc. This
        // form always resolves the arity-suffixed generic and never falls back
        // to a same-named non-generic type (unlike the older bare-name form,
        // which stayed ambiguous for same-base-name multi-arity families such
        // as `Func`/`Action`).
        private GTypeReference MapTypeOfOperand(TypeSyntax type)
        {
            if (IsUnboundGeneric(type, out string unboundName, out int arity))
            {
                var placeholders = new GTypeReference[arity];
                for (int i = 0; i < arity; i++)
                {
                    placeholders[i] = new NamedTypeReference("_");
                }

                return new NamedTypeReference(unboundName, placeholders);
            }

            return this.MapTypeSyntax(type);
        }

        private static bool IsUnboundGeneric(TypeSyntax type, out string name, out int arity)
        {
            name = null;
            arity = 0;
            GenericNameSyntax generic = type switch
            {
                GenericNameSyntax g => g,
                QualifiedNameSyntax { Right: GenericNameSyntax g } => g,
                _ => null,
            };

            if (generic is null ||
                !generic.TypeArgumentList.Arguments.Any(a => a is OmittedTypeArgumentSyntax))
            {
                return false;
            }

            name = generic.Identifier.Text;
            arity = generic.TypeArgumentList.Arguments.Count;
            return true;
        }

        private GTypeReference MapTypeSyntax(TypeSyntax type)
        {
            ITypeSymbol symbol = this.context.GetTypeInfo(type).Type;
            return symbol != null
                ? this.typeMapper.Map(symbol, this.context, type.GetLocation())
                : new NamedTypeReference(type.ToString());
        }

        /// <summary>
        /// Translates the `ref expr` operand of a ref local's initializer
        /// (<c>ref int r = ref xs[1]</c>) or a ref return (<c>return ref
        /// values[1]</c>) — issue #1900. G# has a native ref-aliasing local
        /// (<c>let/var ref name T = lvalue</c>, issue #491/ADR-0060) and a native
        /// ref-returning function (<c>func F(...) ref T { return ref lvalue }</c>,
        /// issue #490); both alias the RHS lvalue directly with no explicit
        /// address-of syntax, so the operand is translated as-is.
        ///
        /// gsc's own lvalue check for both features (<c>IsLvalue</c> /
        /// <c>IsLvalueForRefReturn</c> in StatementBinder.cs) accepts only a
        /// variable, field access, array-element access, or dereference — never a
        /// call result, even one returned by ref. So `ref Pick(xs, 2)` (aliasing a
        /// ref-returning call's result at ANOTHER call/return site) has no gsc
        /// construct to bind to; that shape gaps loudly rather than emitting G#
        /// that fails to compile or, worse, silently drops the aliasing.
        /// </summary>
        private GExpression TranslateRefExpression(RefExpressionSyntax refExpression)
        {
            ExpressionSyntax operand = refExpression.Expression;

            if (operand is IdentifierNameSyntax or ElementAccessExpressionSyntax or MemberAccessExpressionSyntax)
            {
                return this.TranslateExpression(operand);
            }

            this.context.ReportUnsupported(
                refExpression,
                $"ref expression over '{operand.Kind()}' has no canonical G# form yet: G#'s ref-aliasing local/return only aliases a variable, array element, or field — not a call result, even a ref-returning one (issue #1900).");
            return new IdentifierExpression("nil");
        }

        private GExpression TranslatePredefinedTypeExpression(PredefinedTypeSyntax predefined)
        {
            // A C# predefined type used as an expression receiver (`string.Concat`,
            // `int.Parse`) is a static-call target; G# resolves the BCL type name
            // (`String`, `Int32`) there, not the lowercase value keyword, so emit
            // the framework type name (ADR-0115 §B.12 receiver form).
            ITypeSymbol symbol = this.context.GetTypeInfo(predefined).Type;
            string name = symbol?.Name ?? predefined.Keyword.Text;
            return new IdentifierExpression(name);
        }

        private GExpression TranslateImplicitObjectCreation(ImplicitObjectCreationExpressionSyntax creation)
        {
            // A C# target-typed `new()` carries its concrete type only in the bound
            // model; emit the explicit constructed type (`List[T]()`) so the G#
            // construction names the type (ADR-0115 §B.7/§B.16).
            ITypeSymbol typeSymbol = this.context.GetTypeInfo(creation).Type;
            GTypeReference type = typeSymbol != null
                ? this.typeMapper.Map(typeSymbol, this.context, creation.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            var arguments = creation.ArgumentList == null
                ? new List<GExpression>()
                : this.TranslateCallArguments(creation, creation.ArgumentList.Arguments);

            return this.BuildObjectCreationCore(creation, typeSymbol, type, arguments, creation.Initializer);
        }

        private GExpression TranslateSwitchExpression(SwitchExpressionSyntax node)
        {
            GExpression subject = this.TranslateExpression(node.GoverningExpression);
            GTypeReference nullableResultType = this.NullableReferenceSwitchResultType(node);
            var arms = new List<SwitchArm>();
            bool hasTotalArm = false;

            foreach (SwitchExpressionArmSyntax arm in node.Arms)
            {
                // Issue #1730: the pattern's bindings must be installed BEFORE the
                // `when` guard is translated, since the guard can reference them
                // (`Circle { Radius: var r } when r > 0 => ...`). Translating the
                // guard first (the prior order) resolved `r` while it was still
                // out of scope.
                var bindings = new List<(ISymbol Symbol, GExpression Replacement)>();
                var usedDesignators = new HashSet<string>(StringComparer.Ordinal);
                var guards = new List<GExpression>();

                // Issue #1967: `case Index i:`/`Index i =>` binds via a switch
                // pattern designation, not a declarator — check the whole arm
                // pattern tree here.
                this.ReportIndexOrRangeDesignationsInPattern(arm.Pattern);
                GPattern pattern = this.TranslatePattern(arm.Pattern, subject, bindings, usedDesignators, guards);

                foreach ((ISymbol symbol, GExpression replacement) in bindings)
                {
                    this.state.PatternBindings[symbol] = replacement;
                }

                GExpression guard;
                GExpression body;
                try
                {
                    // Issue #991: C# `when` guards now have a canonical G# form.
                    // Issue #1943: a typed positional/property subpattern that
                    // has no room in its `TypePattern` GPattern node (a
                    // constant/relational/nested test) was collected into
                    // `guards` above instead; AND it together with any explicit
                    // `when` clause (`case Point p when p.X == 0 && p.Y == 0 &&
                    // <user guard>:`).
                    guard = arm.WhenClause != null
                        ? this.TranslateExpression(arm.WhenClause.Condition)
                        : null;
                    guard = CombinePatternGuards(guards, guard);
                    body = this.TranslateSwitchArmExpression(arm.Expression, nullableResultType);
                }
                finally
                {
                    foreach ((ISymbol symbol, _) in bindings)
                    {
                        this.state.PatternBindings.Remove(symbol);
                    }
                }

                arms.Add(new SwitchArm(pattern, body, guard));

                // A guarded discard (`case _ when …`) can still fail at run
                // time, so — mirroring gsc's own exhaustiveness rule
                // (diagnostics.md GS0176: "a guarded discard … does not act
                // as a total/default arm") — only an unguarded discard/`default`
                // arm counts as total. `pattern` is `null` for a real C#
                // discard (`_ =>`); it is a `DiscardPattern` node (not `null`)
                // for a `var v =>` arm, which also always matches (it never
                // narrows, so it is total too — see `TranslatePattern`'s
                // `VarPatternSyntax` case above).
                hasTotalArm |= guard == null && (pattern == null || pattern is DiscardPattern);
            }

            // Issue #1962: a C# switch expression can be exhaustive purely by
            // its TYPE arms (e.g. every case of a sealed hierarchy is covered,
            // or a `bool`'s `true`/`false` are both present) with no `_`/`var`
            // catch-all at all — Roslyn proves that exhaustive and requires no
            // default arm. gsc's own exhaustiveness check has no equivalent
            // type-hierarchy proof: it only recognizes a literal unguarded
            // discard/`default:` arm as total (see GS0176 above), so the
            // translated arm set would otherwise trip GS0176 even though the
            // source compiled cleanly. Synthesize a trailing default arm that
            // mirrors C#'s own runtime behavior for an unmatched switch
            // expression value (an implicit throw — C#'s own
            // `SwitchExpressionException`) so gsc accepts the switch and a
            // genuinely-unreachable value still fails loudly instead of
            // silently miscompiling.
            if (!hasTotalArm)
            {
                GTypeReference resultType = this.ResolveExpressionType(node);
                GExpression unmatchedThrow = new ThrowExpression(
                    BuildConstruction(
                        new NamedTypeReference("InvalidOperationException"),
                        new List<GExpression> { LiteralExpression.String("Unmatched switch expression value.") }),
                    resultType);
                arms.Add(new SwitchArm(null, unmatchedThrow, null));
            }

            return new SwitchExpression(subject, arms);
        }

        private GTypeReference NullableReferenceSwitchResultType(SwitchExpressionSyntax node)
        {
            ITypeSymbol resultType = this.context.GetTypeInfo(node).Type;
            if (resultType is not { IsReferenceType: true })
            {
                return null;
            }

            GTypeReference mapped = this.typeMapper.Map(resultType, this.context, node.GetLocation());
            return mapped.IsNullable ? mapped : MakeNullable(mapped);
        }

        // Issue #2412 (round 3): mirrors TranslateValueWithNullForgiveness's
        // ternary-arm handling (Statements.cs, ConditionalExpressionSyntax
        // WhenTrue/WhenFalse) for a switch-EXPRESSION arm's value. Prior to
        // this fix, a switch arm's value was translated with a bare
        // `TranslateExpression` call, so a nullable-tainted arm value never
        // got the `!!` forgiveness a ternary arm in the exact same
        // return-preserving-body position already receives — the detection
        // logic in `FindEnclosingConditionalAndSiblings` already recognized
        // switch arms, but nothing downstream ever consulted it for this call
        // site. `TranslateValueWithNullForgiveness` is safe to reuse as-is: it
        // only adds `!!` when `ReceiverNeedsNullForgiveness` says so (which
        // already excludes literals, so the `IsNullOrDefaultLiteral` branch
        // below is untouched either way).
        private GExpression TranslateSwitchArmExpression(
            ExpressionSyntax expression,
            GTypeReference nullableResultType)
        {
            return nullableResultType != null && IsNullOrDefaultLiteral(expression)
                ? new DefaultValueExpression(nullableResultType)
                : this.TranslateValueWithNullForgiveness(expression);
        }

        // Lowers a C# switch EXPRESSION that appears in statement position
        // (a discard `_ = x switch { ... };` or any other expression-statement)
        // into a G# switch STATEMENT. Each arm's expression is run for its side
        // effect only — the switch value is discarded, exactly as in C# — so the
        // arm body becomes a single-statement block wrapping the arm expression.
        // Mirrors TranslateSwitchExpression's pattern/guard/binding handling and
        // its exhaustiveness rule (issue #914).
        private GStatement TranslateSwitchExpressionAsStatement(SwitchExpressionSyntax node)
        {
            GExpression subject = this.TranslateExpression(node.GoverningExpression);
            var cases = new List<SwitchStatementCase>();
            bool hasTotalArm = false;

            foreach (SwitchExpressionArmSyntax arm in node.Arms)
            {
                var bindings = new List<(ISymbol Symbol, GExpression Replacement)>();
                var usedDesignators = new HashSet<string>(StringComparer.Ordinal);
                var guards = new List<GExpression>();

                this.ReportIndexOrRangeDesignationsInPattern(arm.Pattern);
                GPattern pattern = this.TranslatePattern(arm.Pattern, subject, bindings, usedDesignators, guards);

                foreach ((ISymbol symbol, GExpression replacement) in bindings)
                {
                    this.state.PatternBindings[symbol] = replacement;
                }

                GExpression guard;
                GStatement body;
                try
                {
                    guard = arm.WhenClause != null
                        ? this.TranslateExpression(arm.WhenClause.Condition)
                        : null;
                    guard = CombinePatternGuards(guards, guard);
                    body = this.TranslateSwitchArmExpressionAsStatement(arm.Expression);
                }
                finally
                {
                    foreach ((ISymbol symbol, _) in bindings)
                    {
                        this.state.PatternBindings.Remove(symbol);
                    }
                }

                cases.Add(new SwitchStatementCase(pattern, new BlockStatement(new[] { body }), guard));

                hasTotalArm |= guard == null && (pattern == null || pattern is DiscardPattern);
            }

            // As in TranslateSwitchExpression: a C# switch expression is
            // exhaustive by construction, but gsc's switch only treats a literal
            // unguarded discard/`default` as total (GS0176). When none is present,
            // synthesize a trailing default that throws — mirroring C#'s own
            // runtime SwitchExpressionException for an unmatched value.
            if (!hasTotalArm)
            {
                GExpression unmatchedThrow = new ThrowExpression(
                    BuildConstruction(
                        new NamedTypeReference("InvalidOperationException"),
                        new List<GExpression> { LiteralExpression.String("Unmatched switch expression value.") }),
                    null);
                cases.Add(new SwitchStatementCase(
                    null,
                    new BlockStatement(new[] { (GStatement)new ExpressionStatement(unmatchedThrow) })));
            }

            return new SwitchStatement(subject, cases);
        }

        // Renders a switch-expression arm's value expression as a single G#
        // statement for the discarded switch-statement lowering above. A `throw`
        // arm becomes a throw statement; every other expression is emitted as an
        // expression statement (its value is discarded).
        private GStatement TranslateSwitchArmExpressionAsStatement(ExpressionSyntax expression)
        {
            if (expression is ThrowExpressionSyntax throwExpression)
            {
                return new ThrowStatement(this.TranslateExpression(throwExpression.Expression));
            }

            return new ExpressionStatement(this.TranslateExpression(expression));
        }

        private IEnumerable<GStatement> TranslateSwitchStatement(SwitchStatementSyntax node)
        {
            GExpression subject = this.TranslateExpression(node.Expression);
            var cases = new List<SwitchStatementCase>();

            // Issue #2462: a non-terminal break still has observable control
            // flow after C# switch terminators are removed. Lower it to a jump
            // past the translated switch and emit that target only when needed.
            bool needsExitLabel = node.DescendantNodes()
                .OfType<BreakStatementSyntax>()
                .Any(b => BreakTargetsSwitch(b, node) && !IsRedundantSwitchSectionBreak(b));

            // Issue #1884: a `goto case K;` / `goto default;` anywhere in this
            // switch (but not in a nested switch, whose own gotos target its
            // own labels) needs a synthesized label at the top of the arm it
            // targets, so the goto can be lowered to a plain `goto`.
            var gotoTargets = new HashSet<SwitchLabelSyntax>(
                node.DescendantNodes()
                    .OfType<GotoStatementSyntax>()
                    .Where(g => (g.Kind() == SyntaxKind.GotoCaseStatement || g.Kind() == SyntaxKind.GotoDefaultStatement)
                             && g.Ancestors().OfType<SwitchStatementSyntax>().First() == node)
                    .Select(this.ResolveGotoCaseOrDefaultTarget)
                    .Where(target => target != null));

            foreach (SwitchSectionSyntax section in node.Sections)
            {
                // A G# switch-statement arm carries a single pattern; a C# section
                // that stacks multiple `case` labels (fall-through) has no canonical
                // G# form, so each label is emitted as its own arm. The body is
                // translated per-label (not once per section) because a pattern
                // label's bindings (issue #1730) must be installed before the body
                // is translated, and bindings can differ across stacked labels.
                var labels = section.Labels.ToList();

                foreach (SwitchLabelSyntax label in labels)
                {
                    switch (label)
                    {
                        case CasePatternSwitchLabelSyntax patternLabel:
                            var bindings = new List<(ISymbol Symbol, GExpression Replacement)>();
                            var usedDesignators = new HashSet<string>(StringComparer.Ordinal);
                            var guards = new List<GExpression>();

                            // Issue #1967: same guard as the switch-expression arm
                            // path above, for the switch-statement `case` form.
                            this.ReportIndexOrRangeDesignationsInPattern(patternLabel.Pattern);
                            GPattern pattern = this.TranslatePattern(patternLabel.Pattern, subject, bindings, usedDesignators, guards);

                            // Issue #1730: install the pattern's bindings before
                            // translating the `when` guard and the case body, so
                            // both see the bound variable (`case Circle { Radius:
                            // var r } when r > 0: return r;`). The bindings are
                            // scoped to this label only.
                            foreach ((ISymbol symbol, GExpression replacement) in bindings)
                            {
                                this.state.PatternBindings[symbol] = replacement;
                            }

                            GExpression guard;
                            BlockStatement patternBody;
                            try
                            {
                                // Issue #991: C# `when` guards now have a canonical G# form.
                                // Issue #1943: see the switch-EXPRESSION arm above —
                                // a typed positional/property subpattern with no
                                // room in its `TypePattern` node is collected into
                                // `guards` and AND-ed with any explicit `when`.
                                guard = patternLabel.WhenClause != null
                                    ? this.TranslateExpression(patternLabel.WhenClause.Condition)
                                    : null;
                                guard = CombinePatternGuards(guards, guard);
                                patternBody = this.TranslateSwitchSectionBody(section);
                            }
                            finally
                            {
                                foreach ((ISymbol symbol, _) in bindings)
                                {
                                    this.state.PatternBindings.Remove(symbol);
                                }
                            }

                            cases.Add(new SwitchStatementCase(pattern, patternBody, guard));
                            break;

                        case CaseSwitchLabelSyntax valueLabel:
                            cases.Add(new SwitchStatementCase(
                                new ConstantPattern(this.TranslateExpression(valueLabel.Value)),
                                this.TranslateSwitchSectionBody(
                                    section,
                                    gotoTargets.Contains(valueLabel) ? GotoCaseOrDefaultLabelName(valueLabel) : null)));
                            break;

                        case DefaultSwitchLabelSyntax defaultLabel:
                            cases.Add(new SwitchStatementCase(
                                null,
                                this.TranslateSwitchSectionBody(
                                    section,
                                    gotoTargets.Contains(defaultLabel) ? GotoCaseOrDefaultLabelName(defaultLabel) : null)));
                            break;

                        default:
                            this.context.ReportUnsupported(
                                label,
                                $"switch label '{label.Kind()}' has no canonical G# form yet (ADR-0115 §B).");
                            break;
                    }
                }
            }

            yield return new SwitchStatement(subject, cases);
            if (needsExitLabel)
            {
                yield return new LabeledStatement(
                    SwitchExitLabelName(node),
                    new BlockStatement(new List<GStatement>()));
            }
        }

        private BlockStatement TranslateSwitchSectionBody(SwitchSectionSyntax section, string injectLabel = null)
        {
            var statements = new List<GStatement>();
            foreach (StatementSyntax statement in section.Statements)
            {
                statements.AddRange(this.TranslateStatement(statement));
            }

            if (injectLabel != null)
            {
                // Issue #1884: this arm is the target of a `goto case`/`goto
                // default` elsewhere in the switch; attach the synthesized
                // label to the first statement (or, for an empty arm, to an
                // empty block) so the goto has something concrete to jump to.
                if (statements.Count == 0)
                {
                    statements.Add(new LabeledStatement(injectLabel, new BlockStatement(new List<GStatement>())));
                }
                else
                {
                    statements[0] = new LabeledStatement(injectLabel, statements[0]);
                }
            }

            return new BlockStatement(statements);
        }

        private IEnumerable<GStatement> TranslateBreakStatement(BreakStatementSyntax node)
        {
            // The nearest breakable ancestor is the semantic target. Blocks,
            // conditionals, try/using/lock statements, local functions, and
            // lambdas do not require special cases; nested loops/switches do.
            SwitchStatementSyntax enclosingSwitch = node.Ancestors()
                .OfType<SwitchStatementSyntax>()
                .FirstOrDefault();

            if (enclosingSwitch != null && BreakTargetsSwitch(node, enclosingSwitch))
            {
                if (IsRedundantSwitchSectionBreak(node))
                {
                    return System.Array.Empty<GStatement>();
                }

                return new[] { (GStatement)new GotoStatement(SwitchExitLabelName(enclosingSwitch)) };
            }

            return new[] { (GStatement)new BreakStatement() };
        }

        private static bool BreakTargetsSwitch(BreakStatementSyntax node, SwitchStatementSyntax target)
        {
            SyntaxNode breakTarget = node.Ancestors().FirstOrDefault(IsBreakTarget);
            return breakTarget == target;
        }

        private static bool IsBreakTarget(SyntaxNode node)
            => node is SwitchStatementSyntax
                or ForStatementSyntax
                or CommonForEachStatementSyntax
                or WhileStatementSyntax
                or DoStatementSyntax;

        private static bool IsRedundantSwitchSectionBreak(BreakStatementSyntax node)
        {
            // A break at the end of every containing statement list reaches
            // exactly the point where a G# arm ends naturally.
            SyntaxNode child = node;
            foreach (SyntaxNode ancestor in node.Ancestors())
            {
                if (ancestor is SwitchSectionSyntax section)
                {
                    return section.Statements.LastOrDefault() == child;
                }

                if (ancestor is BlockSyntax block &&
                    child is StatementSyntax statement &&
                    block.Statements.LastOrDefault() != statement)
                {
                    return false;
                }

                child = ancestor;
            }

            return false;
        }

        private static string SwitchExitLabelName(SwitchStatementSyntax node)
            => $"__switchExit{node.SpanStart}";

        private IEnumerable<GStatement> TranslateYieldStatement(YieldStatementSyntax node)
        {
            // `yield return x` maps to the G# iterator `yield x` (sample
            // TupleSequenceIterators.gs); the enclosing func's return type is
            // rewritten to `sequence[T]`. `yield break` maps to plain `break`
            // (settled fact: G# has no `yield break`; ADR-0115 §B).
            if (node.Expression == null)
            {
                return new[] { (GStatement)new BreakStatement() };
            }

            return new[] { (GStatement)new YieldStatement(this.TranslateExpression(node.Expression)) };
        }

        private GStatement TranslateForEachVariable(ForEachVariableStatementSyntax node)
        {
            // `foreach (var (a, b) in xs)` is a C# TUPLE DECONSTRUCTION over a
            // sequence whose element is a tuple. G#'s two-name `for k, v in xs`
            // form is NOT tuple deconstruction — it is index/element iteration
            // (the key is the int32 index), so emitting `for a, b in xs` would
            // bind `a` to the loop index. Issue #1922: G# now has a first-class
            // deconstructing loop header, `for (a, b) in xs { <body> }`, so a
            // synchronous foreach translates directly to that instead of a
            // hidden temp variable plus a separate `let (a, b) = tmp` (ADR-0115
            // §B's older form). G# has no first-class `await for (a, b) in`
            // form, so `await foreach` keeps the older temp+let lowering.
            List<string> names = new List<string>();
            CollectForEachVariableNames(node.Variable, names);

            // Issue #1967: `foreach (var (i, r) in pairs)` declares each element
            // via a designation nested in `node.Variable` — check every one here,
            // this method's single entry point for deconstructing foreach.
            foreach (SingleVariableDesignationSyntax designation in
                node.Variable.DescendantNodesAndSelf().OfType<SingleVariableDesignationSyntax>())
            {
                this.ReportIfIndexOrRangeTypedDesignation(designation);
            }

            if (names.Count >= 2)
            {
                bool isAwait = !node.AwaitKeyword.IsKind(SyntaxKind.None);
                BlockStatement body = this.TranslateStatementAsBlock(node.Statement);
                var iterable = this.TranslateReceiverWithNullForgiveness(node.Expression);

                if (!isAwait)
                {
                    return new ForTupleInStatement(names, iterable, body);
                }

                string pair = $"__decon{this.state.DeconCounter++}";
                var statements = new List<GStatement>(body.Statements.Count + 1)
                {
                    new TupleDeconstructionStatement(
                        BindingKind.Let,
                        names,
                        new IdentifierExpression(pair)),
                };
                statements.AddRange(body.Statements);

                return new ForInStatement(pair, iterable, new BlockStatement(statements), isAwait: true);
            }

            this.context.ReportUnsupported(
                node,
                "foreach tuple deconstruction with arity < 2 has no canonical G# form yet (ADR-0115 §B).");
            return new RawStatement("// unsupported: foreach variable deconstruction");
        }

        private static void CollectForEachVariableNames(ExpressionSyntax variable, List<string> names)
        {
            switch (variable)
            {
                case TupleExpressionSyntax tuple:
                    foreach (ArgumentSyntax argument in tuple.Arguments)
                    {
                        CollectForEachVariableNames(argument.Expression, names);
                    }

                    break;

                case DeclarationExpressionSyntax declaration:
                    CollectDesignationNames(declaration.Designation, names);
                    break;

                case IdentifierNameSyntax identifier:
                    names.Add(SanitizeIdentifier(identifier.Identifier.Text));
                    break;
            }
        }

        private static void CollectDesignationNames(VariableDesignationSyntax designation, List<string> names)
        {
            switch (designation)
            {
                case SingleVariableDesignationSyntax single:
                    names.Add(SanitizeIdentifier(single.Identifier.Text));
                    break;

                case DiscardDesignationSyntax:
                    names.Add("_");
                    break;

                case ParenthesizedVariableDesignationSyntax parenthesized:
                    foreach (VariableDesignationSyntax child in parenthesized.Variables)
                    {
                        CollectDesignationNames(child, names);
                    }

                    break;
            }
        }

        // Issue #1943: AND-folds every boolean test `TranslatePattern` collected
        // into `guards` (a typed positional/property subpattern with no room in
        // its `TypePattern` GPattern node — see `TranslateRecursivePattern`'s
        // `PositionalPatternClause` branch) together with the arm's own explicit
        // `when` clause, if any. Returns <see langword="null"/> when there is
        // nothing to guard on, so a plain arm with no synthesized test and no
        // `when` clause keeps emitting no guard at all.
        private static GExpression CombinePatternGuards(List<GExpression> guards, GExpression whenGuard)
        {
            GExpression combined = null;
            foreach (GExpression guardTest in guards)
            {
                combined = combined == null ? guardTest : new BinaryExpression(combined, "&&", guardTest);
            }

            if (whenGuard == null)
            {
                return combined;
            }

            return combined == null ? whenGuard : new BinaryExpression(combined, "&&", whenGuard);
        }

        private GPattern TranslatePattern(
            PatternSyntax pattern,
            GExpression receiver,
            List<(ISymbol Symbol, GExpression Replacement)> bindings,
            HashSet<string> usedDesignators,
            List<GExpression> guards)
        {
            switch (pattern)
            {
                // Issue #1890: Roslyn parses a bare TYPE name after a combinator
                // (e.g. `int or Widget`) as a ConstantPattern over an identifier
                // — same ambiguity as the boolean-test path's
                // `IsTypeReferencePattern` check — so it must be recognized as a
                // type test before falling through to the literal-equality case
                // below.
                case ConstantPatternSyntax constant when this.IsTypeReferencePattern(constant.Expression):
                    return new TypePattern("_", this.MapTypeReferenceExpression(constant.Expression));

                case ConstantPatternSyntax constant:
                    return new ConstantPattern(this.TranslateExpression(constant.Expression));

                case RelationalPatternSyntax relational:
                    return new RelationalPattern(
                        relational.OperatorToken.Text,
                        this.TranslateExpression(relational.Expression));

                case DiscardPatternSyntax:
                    // The discard arm (`_ =>`) is the G# `default:` arm.
                    return null;

                case DeclarationPatternSyntax declaration
                    when declaration.Designation is SingleVariableDesignationSyntax variable:
                    return new TypePattern(
                        SanitizeIdentifier(variable.Identifier.Text),
                        this.MapTypeSyntax(declaration.Type));

                // Issue #1890: a bare-type arm (`int =>`, no binder) is Roslyn's
                // `TypePatternSyntax` — same shape as `DeclarationPatternSyntax`
                // but with no designation at all. G#'s own `TypePattern` grammar
                // always requires a designator before `is`, but treats `_` as a
                // real discard there (PatternBinder.BindTypePattern's `isDiscard`
                // check), so no binding is introduced — this is the bare form.
                case TypePatternSyntax typePattern:
                    return new TypePattern("_", this.MapTypeSyntax(typePattern.Type));

                // `var v` (a top-level switch arm, or a nested `{ Prop: var v }`
                // subpattern — this method recurses for both) ALWAYS matches, so
                // there is no real test to lower: it maps to the G# discard token
                // `_` (which gsc's own exhaustiveness/binder treats as a total
                // arm — the same as an explicit `default:` — see
                // BindSwitchExpression's `pattern is BoundDiscardPattern` check),
                // and `v` binds via a translator-side substitution of every
                // reference to `receiver` (no runtime pattern is needed since
                // `var` never narrows and also matches `null`) (issue #1888).
                case VarPatternSyntax varPattern:
                    if (varPattern.Designation is SingleVariableDesignationSyntax varVariable &&
                        this.context.GetDeclaredSymbol(varVariable) is { } varBound)
                    {
                        bindings.Add((varBound, receiver));
                    }
                    else if (varPattern.Designation is ParenthesizedVariableDesignationSyntax)
                    {
                        this.context.ReportUnsupported(varPattern, "var pattern with tuple designation ('var (a, b)') has no canonical G# form yet (ADR-0115 §B).");
                    }

                    return new DiscardPattern();

                case RecursivePatternSyntax recursive:
                    return this.TranslateRecursivePattern(recursive, receiver, bindings, usedDesignators, guards);

                // Issue #992: C# `and` / `or` pattern combinators map to G#
                // `and` / `or`. C# `BinaryPatternSyntax` carries an `and`/`or`
                // operator keyword.
                case BinaryPatternSyntax binary
                    when binary.OperatorToken.IsKind(SyntaxKind.AndKeyword) || binary.OperatorToken.IsKind(SyntaxKind.OrKeyword):
                    return new BinaryPattern(
                        binary.OperatorToken.IsKind(SyntaxKind.AndKeyword),
                        this.TranslatePattern(binary.Left, receiver, bindings, usedDesignators, guards),
                        this.TranslatePattern(binary.Right, receiver, bindings, usedDesignators, guards));

                // Issue #992: C# `not <pattern>` maps to G# `not <pattern>`.
                case UnaryPatternSyntax unary
                    when unary.OperatorToken.IsKind(SyntaxKind.NotKeyword):
                    return new NotPattern(this.TranslatePattern(unary.Pattern, receiver, bindings, usedDesignators, guards));

                case ParenthesizedPatternSyntax parenthesized:
                    return new ParenthesizedPattern(this.TranslatePattern(parenthesized.Pattern, receiver, bindings, usedDesignators, guards));

                case ListPatternSyntax listPattern:
                    return this.TranslateListPattern(listPattern, receiver, bindings, usedDesignators, guards);

                default:
                    this.context.ReportUnsupported(
                        pattern,
                        $"pattern '{pattern.Kind()}' has no canonical G# form yet (ADR-0115 §B).");
                    return new DiscardPattern();
            }
        }

        // Issue #1889: G# has a native list pattern (spec §Pattern matching,
        // ListPatternSyntax/SlicePatternSyntax) that structurally matches an
        // array/slice element-by-element — unlike the property/positional-
        // pattern branches above, no manual member-test composition is needed;
        // gsc's own pattern binder tests length and element shape at runtime.
        // Each non-slice, non-discard element still recurses through the shared
        // `TranslatePattern` so a `var`/declaration binder at that position picks
        // up the SAME discard-plus-substitution treatment as everywhere else
        // (issue #1888) — the substitution receiver is the element read at that
        // position (forward from the start, or backward from the end once past
        // the slice, since gsc has no negative array index).
        private GPattern TranslateListPattern(
            ListPatternSyntax listPattern,
            GExpression receiver,
            List<(ISymbol Symbol, GExpression Replacement)> bindings,
            HashSet<string> usedDesignators,
            List<GExpression> guards)
        {
            SeparatedSyntaxList<PatternSyntax> elements = listPattern.Patterns;
            int sliceIndex = FindSlicePatternIndex(elements);
            var lengthAccess = new MemberAccessExpression(receiver, "Length");
            var translated = new List<GPattern>(elements.Count);

            for (int i = 0; i < elements.Count; i++)
            {
                PatternSyntax element = elements[i];
                if (element is SlicePatternSyntax slice)
                {
                    translated.Add(this.TranslateSlicePattern(slice, receiver, i, elements.Count - i - 1, bindings, usedDesignators, guards));
                    continue;
                }

                if (element is DiscardPatternSyntax)
                {
                    translated.Add(new DiscardPattern());
                    continue;
                }

                GExpression elementReceiver = this.BuildListElementReceiver(receiver, lengthAccess, i, elements.Count, sliceIndex);
                translated.Add(this.TranslatePattern(element, elementReceiver, bindings, usedDesignators, guards));
            }

            return new ListPattern(translated);
        }

        // Issue #1889: a named capture (`.. var rest`/`.. T rest`) binds directly
        // to G#'s own slice-capture designator (`..rest`) — a REAL runtime
        // binding (unlike a scalar element's `var`, this one needs no
        // discard-plus-substitution: the captured name IS the designator, so
        // references to it in the arm body resolve naturally). A nested
        // subpattern (`..[> 0]`) recurses through `TranslatePattern` against the
        // materialized slice value, matching G#'s own `SlicePattern.Pattern`
        // (spec §Pattern matching). A bare `..` carries neither.
        private GPattern TranslateSlicePattern(
            SlicePatternSyntax slice,
            GExpression receiver,
            int prefixCount,
            int suffixCount,
            List<(ISymbol Symbol, GExpression Replacement)> bindings,
            HashSet<string> usedDesignators,
            List<GExpression> guards)
        {
            switch (slice.Pattern)
            {
                case null:
                    return new SlicePattern(designator: null);

                case VarPatternSyntax { Designation: SingleVariableDesignationSyntax variable }:
                    return new SlicePattern(SanitizeIdentifier(variable.Identifier.Text));

                case VarPatternSyntax { Designation: DiscardDesignationSyntax }:
                    return new SlicePattern(designator: null);

                case VarPatternSyntax varTuple when varTuple.Designation is ParenthesizedVariableDesignationSyntax:
                    this.context.ReportUnsupported(varTuple, "var pattern with tuple designation ('var (a, b)') has no canonical G# form yet (ADR-0115 §B).");
                    return new SlicePattern(designator: null);

                case DeclarationPatternSyntax { Designation: SingleVariableDesignationSyntax declVariable }:
                    // G#'s slice capture designator is always typed as the
                    // slice's own `[]T`, so the (redundant) C# declared type is
                    // dropped — same bind-only treatment as the `var` capture above.
                    return new SlicePattern(SanitizeIdentifier(declVariable.Identifier.Text));

                default:
                    GExpression sliceValue = BuildSliceExpression(receiver, prefixCount, suffixCount);
                    return new SlicePattern(designator: null, this.TranslatePattern(slice.Pattern, sliceValue, bindings, usedDesignators, guards));
            }
        }

        private GPattern TranslateRecursivePattern(
            RecursivePatternSyntax recursive,
            GExpression receiver,
            List<(ISymbol Symbol, GExpression Replacement)> bindings,
            HashSet<string> usedDesignators,
            List<GExpression> guards)
        {
            // A pure property pattern (`{ A: 0, B: 0 }`) with no type maps to the
            // G# property pattern; a typed recursive pattern (`Circle { Radius: var r }`)
            // maps to a type pattern whose designator is the binding receiver.
            if (recursive.Type == null)
            {
                var fields = new List<PropertyPatternField>();
                if (recursive.PropertyPatternClause != null)
                {
                    var extendedFieldTrees = new Dictionary<string, ExtendedPropertyFieldTree>();
                    var extendedFieldRootOrder = new List<string>();
                    foreach (SubpatternSyntax sub in recursive.PropertyPatternClause.Subpatterns)
                    {
                        if (sub.NameColon != null)
                        {
                            string fieldName = SanitizeIdentifier(sub.NameColon.Name.Identifier.Text);
                            fields.Add(new PropertyPatternField(
                                fieldName,
                                this.TranslatePattern(
                                    sub.Pattern,
                                    new MemberAccessExpression(receiver, fieldName),
                                    bindings,
                                    usedDesignators,
                                    guards)));
                            continue;
                        }

                        if (sub.ExpressionColon != null)
                        {
                            // Issue #1891: an extended property subpattern
                            // (`Start.X: 0`) parses as `ExpressionColon`, not
                            // `NameColon`. G#'s property-pattern field is a single
                            // identifier (no dotted member path), so the chain
                            // lowers to nested `PropertyPattern`s instead —
                            // `Start.X: 0` becomes `Start: { X: 0 }`, agreeing
                            // with the nested-pattern form a user could already
                            // write directly. Works to any chain depth.
                            //
                            // Issue #1971: multiple subpatterns sharing a
                            // leftmost identifier (`{ A.B: 0, A.C: 1 }`) must
                            // merge into ONE nested field (`{ A: { B: 0, C: 1 } }`)
                            // instead of emitting the top-level field `A` twice —
                            // grouped here via `extendedFieldTrees`, keyed by the
                            // sanitized root identifier, and converted once all
                            // subpatterns have been scanned. `fields` reserves the
                            // root's position at its FIRST occurrence so field
                            // order still matches the source.
                            List<string> names = SplitMemberPath(sub.ExpressionColon.Expression);
                            string rootName = SanitizeIdentifier(names[0]);
                            if (!extendedFieldTrees.TryGetValue(rootName, out ExtendedPropertyFieldTree tree))
                            {
                                tree = new ExtendedPropertyFieldTree();
                                extendedFieldTrees[rootName] = tree;
                                extendedFieldRootOrder.Add(rootName);
                                fields.Add(null); // placeholder, filled in after the loop
                            }

                            tree.Insert(names, 1, sub.Pattern);
                            continue;
                        }

                        this.context.ReportUnsupported(sub, "positional subpattern has no canonical G# form yet (ADR-0115 §B).");
                    }

                    if (extendedFieldRootOrder.Count > 0)
                    {
                        int placeholderIndex = 0;
                        foreach (string rootName in extendedFieldRootOrder)
                        {
                            while (fields[placeholderIndex] != null)
                            {
                                placeholderIndex++;
                            }

                            ExtendedPropertyFieldTree tree = extendedFieldTrees[rootName];
                            if (tree.HasCollision)
                            {
                                // Bug (N1, Opus review of #1971): a path segment
                                // that is BOTH a leaf value check (`A.B: 0`) AND
                                // a nested-member check (`A.B.C: 1`) at the same
                                // name cannot be merged into a single
                                // PropertyPattern field — one side would have to
                                // be silently dropped. Per ADR-0115 ("never
                                // guess"), report the gap loudly instead of
                                // guessing which side to keep, and fall back to
                                // an empty nested field for '{rootName}' so the
                                // merge optimization doesn't emit a
                                // semantically-wrong pattern.
                                this.context.ReportUnsupported(
                                    recursive.PropertyPatternClause,
                                    $"extended property pattern mixes a direct value check and a nested member check on the same path segment '{tree.CollisionSegment}' (rooted at '{rootName}'); not supported.");
                                fields[placeholderIndex] = new PropertyPatternField(rootName, new PropertyPattern(new List<PropertyPatternField>()));
                                continue;
                            }

                            List<PropertyPatternField> childFields = tree.ConvertChildren(
                                this, new MemberAccessExpression(receiver, rootName), bindings, usedDesignators, guards);
                            fields[placeholderIndex] = new PropertyPatternField(rootName, new PropertyPattern(childFields));
                        }
                    }
                }

                if (recursive.PositionalPatternClause != null)
                {
                    // Issue #1887: a bare positional pattern arm (`(0, 0) =>`,
                    // `(0, _) or (>0, >0) =>`) has no type prefix, so — same as
                    // the untyped property-pattern branch above — it lowers to a
                    // G# property pattern whose fields are the tuple/record
                    // members each position deconstructs to.
                    SeparatedSyntaxList<SubpatternSyntax> subs = recursive.PositionalPatternClause.Subpatterns;
                    string[] memberNames = this.TryGetPositionalMemberNames(recursive, subs.Count);
                    for (int i = 0; i < subs.Count; i++)
                    {
                        SubpatternSyntax sub = subs[i];
                        if (sub.Pattern is DiscardPatternSyntax)
                        {
                            // A discard position (`(0, _)`) imposes no constraint —
                            // same as an omitted field in a property pattern — so
                            // it contributes no field at all.
                            continue;
                        }

                        string memberName = sub.NameColon?.Name.Identifier.Text ?? memberNames?[i];
                        if (memberName == null)
                        {
                            this.context.ReportUnsupported(sub, "positional subpattern has no canonical G# form yet (ADR-0115 §B).");
                            continue;
                        }

                        fields.Add(new PropertyPatternField(
                            SanitizeIdentifier(memberName),
                            this.TranslatePattern(
                                sub.Pattern,
                                new MemberAccessExpression(receiver, SanitizeIdentifier(memberName)),
                                bindings,
                                usedDesignators,
                                guards)));
                    }
                }

                return new PropertyPattern(fields);
            }

            // Typed recursive pattern: synthesize a designator named after the type
            // (`circle`), and rewrite each `Name: var x` property binding to a
            // member access on that designator (`circle.Radius`). The synthesized
            // designator is derived from the right-most identifier token of the
            // type syntax (not `Type.ToString()`, which yields an invalid
            // identifier for a qualified/generic type such as `Ns.Circle` or
            // `List<int>`), and sanitized like every other declared/synthesized
            // name so a keyword-colliding designator agrees with its references
            // (issue #1734).
            string designator = recursive.Designation is SingleVariableDesignationSyntax named
                ? SanitizeIdentifier(named.Identifier.Text)
                : SanitizeIdentifier(LowerCamel(GetRightmostTypeName(recursive.Type)));

            // Issue #1839 (N3): two typed recursive subpatterns within the SAME
            // arm/scope (e.g. `Ns.Circle or Other.Circle`) can synthesize the
            // identical designator from their distinct rightmost simple names,
            // which would silently shadow one another as two `circle` locals.
            // Uniquify on collision within this arm's shared `usedDesignators`
            // scope (threaded alongside `bindings`) rather than emitting a
            // colliding declaration.
            designator = Uniquify(designator, usedDesignators);

            if (recursive.PropertyPatternClause != null)
            {
                foreach (SubpatternSyntax sub in recursive.PropertyPatternClause.Subpatterns)
                {
                    if (sub.NameColon != null &&
                        sub.Pattern is VarPatternSyntax { Designation: SingleVariableDesignationSyntax bound } &&
                        this.context.GetDeclaredSymbol(bound) is { } boundSymbol)
                    {
                        bindings.Add((
                            boundSymbol,
                            new MemberAccessExpression(
                                new IdentifierExpression(designator),
                                SanitizeIdentifier(sub.NameColon.Name.Identifier.Text))));
                    }
                    else
                    {
                        this.context.ReportUnsupported(
                            sub,
                            "typed property subpattern other than a 'var' binding has no canonical G# form yet (ADR-0115 §B).");
                    }
                }
            }

            if (recursive.PositionalPatternClause != null)
            {
                // Issue #1887: a TYPED recursive pattern (`Point(0, 0)`, `Point(var
                // x, var y)`) lowers to a `TypePattern` GPattern node, which — same
                // as the typed property-pattern branch above — carries only a
                // designator and a type, no room for an extra equality/relational
                // test. A `var` positional subpattern still binds cleanly (a member
                // access on the designator).
                //
                // Issue #1943: anything else (a constant/relational/nested
                // positional subpattern, e.g. `Point(0, 0)`, `Point(> 0, _)`)
                // generalizes the same lowering the untyped bare-tuple arm form
                // already uses (`TranslateRecursivePatternTest`'s
                // `PositionalPatternClause` loop) — a boolean member-access test —
                // but since a `TypePattern` has no room for it, the test is
                // appended to the arm's `guards` list instead, to be AND-ed with
                // any explicit `when` clause by the caller (`case Point p when
                // p.X == 0 && p.Y == 0:`). Any designator a nested subpattern
                // binds (e.g. `Point(Sub(var a, 0), _)`) is captured into
                // `bindings` the same way the property-pattern loop above does,
                // so it is installed/removed on the same schedule as every other
                // arm-scoped binding.
                SeparatedSyntaxList<SubpatternSyntax> subs = recursive.PositionalPatternClause.Subpatterns;
                string[] memberNames = this.TryGetPositionalMemberNames(recursive, subs.Count);
                for (int i = 0; i < subs.Count; i++)
                {
                    SubpatternSyntax sub = subs[i];
                    if (sub.Pattern is DiscardPatternSyntax)
                    {
                        // A discard position (`Point(0, _)`) imposes no
                        // constraint and binds nothing, so no field is needed.
                        continue;
                    }

                    string memberName = sub.NameColon?.Name.Identifier.Text ?? memberNames?[i];
                    if (memberName == null)
                    {
                        this.context.ReportUnsupported(
                            sub,
                            "typed positional subpattern has no canonical G# form yet (ADR-0115 §B).");
                        continue;
                    }

                    if (sub.Pattern is VarPatternSyntax { Designation: SingleVariableDesignationSyntax posBound } &&
                        this.context.GetDeclaredSymbol(posBound) is { } posBoundSymbol)
                    {
                        bindings.Add((
                            posBoundSymbol,
                            new MemberAccessExpression(
                                new IdentifierExpression(designator),
                                SanitizeIdentifier(memberName))));
                        continue;
                    }

                    GExpression memberAccess = new MemberAccessExpression(
                        new IdentifierExpression(designator), SanitizeIdentifier(memberName));
                    var bindingsBefore = new HashSet<ISymbol>(this.state.PatternBindings.Keys, SymbolEqualityComparer.Default);
                    GExpression memberTest = this.TranslatePatternTest(memberAccess, sub.Pattern, isNestedPatternMember: true);
                    foreach (ISymbol added in this.state.PatternBindings.Keys.ToList())
                    {
                        if (!bindingsBefore.Contains(added))
                        {
                            // A nested subpattern (e.g. `Point(Sub(var a, 0), _)`)
                            // binds its own designator directly into
                            // `patternBindings` (the same mechanism an `is`
                            // expression uses). Route it through `bindings` too so
                            // the caller's install/remove-around-guard-and-body
                            // scoping (mirroring the `is`-expression pattern
                            // above) cleans it up like every other arm binding.
                            bindings.Add((added, this.state.PatternBindings[added]));
                        }
                    }

                    guards.Add(memberTest);
                }
            }

            return new TypePattern(designator, this.MapTypeSyntax(recursive.Type));
        }

        private static string LowerCamel(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                return name;
            }

            return char.ToLowerInvariant(name[0]) + name.Substring(1);
        }

        // Issue #1839 (N3): appends a numeric suffix (`circle_2`, `circle_3`, …)
        // when `name` was already used earlier in the same arm/scope, so two
        // typed recursive subpatterns that happen to collapse to the same
        // designator (distinct types sharing a rightmost simple name, or an
        // explicit designation colliding with a synthesized one) get distinct,
        // compilable locals instead of silently shadowing one another.
        private static string Uniquify(string name, HashSet<string> usedDesignators)
        {
            string candidate = name;
            int suffix = 2;
            while (!usedDesignators.Add(candidate))
            {
                candidate = $"{name}_{suffix}";
                suffix++;
            }

            return candidate;
        }

        // Extracts the right-most simple-name identifier token from a (possibly
        // qualified/generic) type syntax, e.g. `Ns.Circle` -> "Circle",
        // `List<int>` -> "List", `Outer.Inner<T>` -> "Inner". `Type.ToString()`
        // renders the full qualified/generic text, which is not itself a valid
        // identifier and must never be used to synthesize a designator name
        // (issue #1734).
        //
        // Issue #1839 (N2): a predefined type (`int`) resolves to its BCL name
        // via the semantic model — the same resolution `TranslatePredefinedTypeExpression`
        // uses for a predefined-type expression receiver — rather than the
        // lowercase keyword text (`int`), which is itself a G# keyword and not a
        // valid designator once sanitized. Nullable/array types recurse into
        // their element type, since `int?`/`int[]` designate the same underlying
        // simple type as `int`. A tuple, pointer, or function-pointer type has no
        // single simple name to derive a faithful designator from, so a
        // diagnostic is reported instead of emitting the unsanitized, invalid
        // `Type.ToString()` text (`(int, int)`, `int*`, `delegate*<int, int>`).
        private string GetRightmostTypeName(TypeSyntax type)
        {
            switch (type)
            {
                case QualifiedNameSyntax qualified:
                    return GetRightmostTypeName(qualified.Right);
                case AliasQualifiedNameSyntax aliasQualified:
                    return GetRightmostTypeName(aliasQualified.Name);
                case SimpleNameSyntax simple:
                    return simple.Identifier.Text;
                case PredefinedTypeSyntax predefined:
                    ITypeSymbol predefinedSymbol = this.context.GetTypeInfo(predefined).Type;
                    return predefinedSymbol?.Name ?? predefined.Keyword.Text;
                case NullableTypeSyntax nullable:
                    return GetRightmostTypeName(nullable.ElementType);
                case ArrayTypeSyntax array:
                    return GetRightmostTypeName(array.ElementType);
                case TupleTypeSyntax:
                case PointerTypeSyntax:
                case FunctionPointerTypeSyntax:
                    this.context.ReportUnsupported(
                        type,
                        $"recursive pattern designator cannot be synthesized from type '{type.Kind()}'; give the pattern an explicit designation (ADR-0115 §B).");
                    return "value";
                default:
                    return type.ToString();
            }
        }

        private GExpression TranslateQuery(QueryExpressionSyntax query)
        {
            // G# has no query-comprehension syntax; lower the C# query to the
            // equivalent System.Linq method chain (`from … where … orderby …
            // select …` → `.Where(…).OrderBy(…).Select(…)`, ADR-0115 §B LINQ).
            FromClauseSyntax from = query.FromClause;
            this.ReportIfIndexOrRangeTypedRangeVariable(from, from.Identifier, from.Type, from.Expression);
            GExpression current = this.TranslateExpression(from.Expression);
            GTypeReference rangeType = this.ResolveRangeVariableType(from.Type, from.Expression, from);

            // The query's "scope" is the set of range variables in play, in
            // declaration order — the C# spec's transparent identifier (§12.19.3).
            // A lone `from` starts with one; a second `from`, a `let`, or a `join`
            // grows it. G# has no anonymous types to carry more than one variable
            // through a lambda, so scope.Count > 1 is threaded as a positional
            // tuple (see <see cref="BuildScopeParameter"/>).
            var scope = new List<(string Name, GTypeReference Type)> { (from.Identifier.Text, rangeType) };

            // Issue #1998: track the enclosing query node so a scope that grows
            // past G#'s tuple arity cap (see <see cref="BuildScopeParameter"/>)
            // can anchor a precise diagnostic rather than silently emitting a
            // tuple shape that would only surface as an opaque GS0159 much
            // later, at G# bind time. Save/restore to stay correct for a
            // (rare) query nested inside this one's lambda bodies.
            QueryExpressionSyntax previousQueryNode = this.state.CurrentQueryNode;
            this.state.CurrentQueryNode = query;
            try
            {
                current = this.LowerQueryBody(query.Body, scope, current);
            }
            finally
            {
                this.state.CurrentQueryNode = previousQueryNode;
            }

            return current;
        }

        // Determines a query range variable's element type. An explicit type
        // (`from T x in xs`) wins; otherwise the type is derived from the source
        // collection the same way C#'s foreach/query-from does: array element
        // type, `IEnumerable<T>`'s `T`, or (for a dictionary) the `T` in the
        // `IEnumerable<KeyValuePair<K,V>>` the dictionary implements — via the
        // shared `GetEnumerableElementType` helper (issue #1738), not the former
        // narrow "first generic type argument" guess that mistyped arrays
        // (`object`) and dictionaries (the key type instead of `KeyValuePair`).
        private GTypeReference ResolveRangeVariableType(
            TypeSyntax explicitType, ExpressionSyntax source, SyntaxNode anchor)
        {
            if (explicitType != null)
            {
                return this.MapTypeSyntax(explicitType);
            }

            ITypeSymbol elementType = this.ResolveRangeVariableElementTypeSymbol(source);
            if (elementType != null)
            {
                return this.typeMapper.Map(elementType, this.context, anchor.GetLocation());
            }

            this.context.ReportUnsupported(
                anchor,
                "query range variable's element type could not be determined from its source collection (ADR-0115 §B).");
            return new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);
        }

        // Shared by `ResolveRangeVariableType` (above) and the issue #1967
        // Index/Range loud-gap check below: the source collection's element
        // type, the same way C#'s foreach/query-from infers an implicit range
        // variable's type (array element type, `IEnumerable<T>`'s `T`, or a
        // dictionary's `KeyValuePair<K,V>`) via `GetEnumerableElementType`.
        private ITypeSymbol ResolveRangeVariableElementTypeSymbol(ExpressionSyntax source)
        {
            ITypeSymbol sourceType = this.context.GetTypeInfo(source).Type
                ?? this.context.GetTypeInfo(source).ConvertedType;
            return GetEnumerableElementType(sourceType);
        }

        private GExpression LowerQueryBody(
            QueryBodySyntax body,
            List<(string Name, GTypeReference Type)> scope,
            GExpression current)
        {
            foreach (QueryClauseSyntax clause in body.Clauses)
            {
                switch (clause)
                {
                    case WhereClauseSyntax where:
                        current = this.QueryCall(current, "Where", scope, where.Condition);
                        break;

                    case OrderByClauseSyntax orderBy:
                        bool first = true;
                        foreach (OrderingSyntax ordering in orderBy.Orderings)
                        {
                            bool descending = ordering.AscendingOrDescendingKeyword.IsKind(SyntaxKind.DescendingKeyword);
                            string method = (first ? "OrderBy" : "ThenBy") + (descending ? "Descending" : string.Empty);
                            current = this.QueryCall(current, method, scope, ordering.Expression);
                            first = false;
                        }

                        break;

                    case LetClauseSyntax let:
                        current = this.LowerLetClause(let, scope, current);
                        break;

                    case FromClauseSyntax additionalFrom:
                        current = this.LowerAdditionalFromClause(additionalFrom, scope, current);
                        break;

                    case JoinClauseSyntax join:
                        current = this.LowerJoinClause(join, scope, current);
                        break;

                    default:
                        this.context.ReportUnsupported(
                            clause,
                            $"query clause '{clause.Kind()}' has no canonical G# lowering yet (ADR-0115 §B).");
                        break;
                }
            }

            // The result element type after this body's select/group runs, used to
            // type the range variable of an `into` continuation (below). Defaults
            // to the unchanged scope for an elided identity `select n` — a single
            // variable stays itself, a transparent identifier (scope.Count > 1)
            // surfaces as the positional tuple it was already threaded as.
            GTypeReference resultType = scope.Count == 1
                ? scope[0].Type
                : new TupleTypeReference(scope.Select(v => v.Type).ToList());

            // Tracks the projected `select` expression's resolved `ITypeSymbol`
            // (issue #1967) so a continuation's `into y` can be checked for an
            // Index/Range projection below — `resultType` alone is a `GTypeReference`
            // and has already lost that information by the time the continuation
            // runs. Left null for an elided identity `select`/`group` continuation:
            // either case re-uses an already-declared range variable's type, whose
            // Index/Range loud gap (if any) was already reported at its own `from`/
            // `let`/`join` site.
            ITypeSymbol resultTypeSymbol = null;

            switch (body.SelectOrGroup)
            {
                case SelectClauseSyntax select:
                    // An identity projection (`select n`) after another clause is a
                    // no-op the C# compiler elides; keep it only when it transforms.
                    if (scope.Count == 1 && select.Expression is IdentifierNameSyntax id
                        && id.Identifier.Text == scope[0].Name && body.Clauses.Count > 0)
                    {
                        break;
                    }

                    current = this.QueryCall(current, "Select", scope, select.Expression);
                    resultTypeSymbol = this.context.GetTypeInfo(select.Expression).Type;
                    resultType = resultTypeSymbol is { } projected
                        ? this.typeMapper.Map(projected, this.context, select.GetLocation())
                        : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);
                    break;

                case GroupClauseSyntax group:
                    current = this.LowerGroupClause(group, scope, current, out resultType);
                    break;

                default:
                    this.context.ReportUnsupported(
                        body.SelectOrGroup,
                        $"query '{body.SelectOrGroup.Kind()}' has no canonical G# lowering yet (ADR-0115 §B).");
                    return current;
            }

            // `... into y ...` (a query continuation) is the C# spec's own sugar
            // for `from y in (...) ...` — lower it as a nested query body over the
            // projected sequence rather than silently dropping the continuation's
            // clauses (issue #1738). This covers both a `select … into y` and a
            // `group … by … into y` continuation (issue #1902) — either way `y`
            // re-starts the scope as a single range variable over the projection.
            if (body.Continuation != null)
            {
                this.ReportIfIndexOrRangeTypedRangeVariable(body.Continuation, body.Continuation.Identifier, resultTypeSymbol);
                var continuationScope = new List<(string Name, GTypeReference Type)>
                {
                    (SanitizeIdentifier(body.Continuation.Identifier.Text), resultType),
                };
                current = this.LowerQueryBody(body.Continuation.Body, continuationScope, current);
            }

            return current;
        }

        // Lowers `let x = e` (spec §12.19.3.4): a Select projecting the current
        // scope's transparent identifier widened by one member, `x`. Mirrors the
        // spec's `(...).Select(x1 => new{x1, x2 = e})` — sans anonymous types, a
        // positional tuple carries the widened scope forward.
        private GExpression LowerLetClause(
            LetClauseSyntax let,
            List<(string Name, GTypeReference Type)> scope,
            GExpression current)
        {
            var prologue = new List<GStatement>();
            Parameter param = this.BuildScopeParameter(scope, prologue);
            this.ReportIfIndexOrRangeTypedRangeVariable(let, let.Identifier, this.context.GetTypeInfo(let.Expression).Type);
            GExpression letValue = this.TranslateExpression(let.Expression);
            GTypeReference letType = this.context.GetTypeInfo(let.Expression).Type is { } t
                ? this.typeMapper.Map(t, this.context, let.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            List<GExpression> elements = scope
                .Select(v => (GExpression)new IdentifierExpression(SanitizeIdentifier(v.Name)))
                .ToList();
            elements.Add(letValue);
            prologue.Add(new ReturnStatement(new TupleLiteralExpression(elements)));

            var lambda = new LambdaExpression(new List<Parameter> { param }, blockBody: new BlockStatement(prologue));
            current = new InvocationExpression(
                new MemberAccessExpression(current, "Select"),
                new List<GExpression> { lambda });

            scope.Add((let.Identifier.Text, letType));
            return current;
        }

        // Lowers a second (or later) `from` clause (spec §12.19.3.3, SelectMany):
        // `(...).SelectMany(x1 => e2, (x1, x2) => new{x1, x2})`. The
        // collection-selector runs over the CURRENT scope; the result-selector
        // widens it by the new range variable, same transparent-identifier tuple
        // as `let` above.
        private GExpression LowerAdditionalFromClause(
            FromClauseSyntax from,
            List<(string Name, GTypeReference Type)> scope,
            GExpression current)
        {
            LambdaExpression collectionSelector = this.BuildScopeLambda(scope, from.Expression);
            this.ReportIfIndexOrRangeTypedRangeVariable(from, from.Identifier, from.Type, from.Expression);
            GTypeReference newVarType = this.ResolveRangeVariableType(from.Type, from.Expression, from);
            (string Name, GTypeReference Type) newVar = (from.Identifier.Text, newVarType);
            LambdaExpression resultSelector = this.BuildTransparentResultSelector(scope, newVar);

            current = new InvocationExpression(
                new MemberAccessExpression(current, "SelectMany"),
                new List<GExpression> { collectionSelector, resultSelector });

            scope.Add(newVar);
            return current;
        }

        // Lowers `join x2 in e2 on k1 equals k2 [into g]` (spec §12.19.3.7/.8):
        // an inner join is `Join(e2, x1 => k1, x2 => k2, (x1, x2) => new{x1, x2})`;
        // a group join (`into g`) is the same shape over `GroupJoin`, widening the
        // scope by `g : IEnumerable<TInner>` instead of the bare inner variable.
        private GExpression LowerJoinClause(
            JoinClauseSyntax join,
            List<(string Name, GTypeReference Type)> scope,
            GExpression current)
        {
            GExpression inner = this.TranslateExpression(join.InExpression);
            this.ReportIfIndexOrRangeTypedRangeVariable(join, join.Identifier, join.Type, join.InExpression);
            GTypeReference innerVarType = this.ResolveRangeVariableType(join.Type, join.InExpression, join);
            var innerVar = (Name: join.Identifier.Text, Type: innerVarType);

            LambdaExpression outerKeySelector = this.BuildScopeLambda(scope, join.LeftExpression);
            LambdaExpression innerKeySelector = this.BuildScopeLambda(
                new List<(string Name, GTypeReference Type)> { innerVar }, join.RightExpression);

            if (join.Into == null)
            {
                LambdaExpression resultSelector = this.BuildTransparentResultSelector(scope, innerVar);
                current = new InvocationExpression(
                    new MemberAccessExpression(current, "Join"),
                    new List<GExpression> { inner, outerKeySelector, innerKeySelector, resultSelector });
                scope.Add(innerVar);
                return current;
            }

            // Group join: the `into g` variable is always `IEnumerable<TInner>`
            // (spec §12.19.3.8) — no C# expression to infer it from, so it is
            // built directly from the already-resolved inner element type.
            // `sequence[T]` is G#'s spelling for `IEnumerable<T>` (see the
            // `GetEnumerableElementType`/array-iteration lowering above).
            // `into g` is always `IEnumerable<TInner>` (spec §12.19.3.8) — never
            // Index/Range itself — so no loud-gap check applies here.
            var groupVar = (
                Name: join.Into.Identifier.Text,
                Type: (GTypeReference)new NamedTypeReference("sequence", new List<GTypeReference> { innerVarType }));
            LambdaExpression groupResultSelector = this.BuildTransparentResultSelector(scope, groupVar);
            current = new InvocationExpression(
                new MemberAccessExpression(current, "GroupJoin"),
                new List<GExpression> { inner, outerKeySelector, innerKeySelector, groupResultSelector });
            scope.Add(groupVar);
            return current;
        }

        // Lowers `group e by k` (spec §12.19.3.9): the two-argument
        // `GroupBy(x1 => k, x1 => e)`, eliding the element-selector to the
        // single-argument `GroupBy(x1 => k)` for the identity case (`group n by
        // …`) the same way an identity `select n` is elided above. The query's
        // element type becomes `IGrouping<TKey, TElement>`.
        private GExpression LowerGroupClause(
            GroupClauseSyntax group,
            List<(string Name, GTypeReference Type)> scope,
            GExpression current,
            out GTypeReference resultType)
        {
            LambdaExpression keySelector = this.BuildScopeLambda(scope, group.ByExpression);
            GTypeReference keyType = this.context.GetTypeInfo(group.ByExpression).Type is { } k
                ? this.typeMapper.Map(k, this.context, group.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            bool isIdentity = scope.Count == 1
                && group.GroupExpression is IdentifierNameSyntax id
                && id.Identifier.Text == scope[0].Name;

            var args = new List<GExpression> { keySelector };
            GTypeReference elementType;
            if (isIdentity)
            {
                elementType = scope[0].Type;
            }
            else
            {
                args.Add(this.BuildScopeLambda(scope, group.GroupExpression));
                elementType = this.context.GetTypeInfo(group.GroupExpression).Type is { } e
                    ? this.typeMapper.Map(e, this.context, group.GetLocation())
                    : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);
            }

            current = new InvocationExpression(new MemberAccessExpression(current, "GroupBy"), args);
            resultType = new NamedTypeReference("IGrouping", new List<GTypeReference> { keyType, elementType });
            return current;
        }

        private GExpression QueryCall(
            GExpression receiver,
            string method,
            List<(string Name, GTypeReference Type)> scope,
            ExpressionSyntax lambdaBody)
        {
            LambdaExpression lambda = this.BuildScopeLambda(scope, lambdaBody);
            return new InvocationExpression(
                new MemberAccessExpression(receiver, method),
                new List<GExpression> { lambda });
        }

        // Builds a lambda over the current query scope: a single scope variable
        // becomes a plain `(x) -> body`; a transparent identifier (scope.Count >
        // 1) becomes a tuple-parameter lambda that first deconstructs the tuple
        // back into the individual range-variable names `body` refers to (see
        // <see cref="BuildScopeParameter"/>).
        private LambdaExpression BuildScopeLambda(
            List<(string Name, GTypeReference Type)> scope,
            ExpressionSyntax lambdaBody)
        {
            var prologue = new List<GStatement>();
            Parameter param = this.BuildScopeParameter(scope, prologue);
            if (prologue.Count == 0)
            {
                return new LambdaExpression(
                    new List<Parameter> { param },
                    expressionBody: this.TranslateExpression(lambdaBody));
            }

            prologue.Add(new ReturnStatement(this.TranslateExpression(lambdaBody)));
            return new LambdaExpression(new List<Parameter> { param }, blockBody: new BlockStatement(prologue));
        }

        // Builds the `(x1, x2) => new{x1, x2}` result-selector shape shared by
        // SelectMany/Join/GroupJoin (spec §12.19.3.3/.7/.8): one parameter for
        // the left-hand (current) scope, one for the newly introduced variable,
        // returning the widened scope as a positional tuple.
        private LambdaExpression BuildTransparentResultSelector(
            List<(string Name, GTypeReference Type)> leftScope,
            (string Name, GTypeReference Type) rightVar)
        {
            var prologue = new List<GStatement>();
            Parameter leftParam = this.BuildScopeParameter(leftScope, prologue);
            var rightParam = new Parameter(SanitizeIdentifier(rightVar.Name), rightVar.Type);

            List<GExpression> elements = leftScope
                .Select(v => (GExpression)new IdentifierExpression(SanitizeIdentifier(v.Name)))
                .ToList();
            elements.Add(new IdentifierExpression(SanitizeIdentifier(rightVar.Name)));
            prologue.Add(new ReturnStatement(new TupleLiteralExpression(elements)));

            return new LambdaExpression(
                new List<Parameter> { leftParam, rightParam },
                blockBody: new BlockStatement(prologue));
        }

        // Builds the formal parameter a query-scope lambda binds to: a single
        // variable binds directly by name; a transparent identifier
        // (scope.Count > 1) binds a synthetic tuple parameter and appends a `let
        // (x1, x2, …) = __qN` deconstruction to `prologue` so the lambda body can
        // still refer to each range variable by its own name (issue #1902 — G#
        // has no anonymous types to bind the C# spec's transparent identifier to).
        private Parameter BuildScopeParameter(
            List<(string Name, GTypeReference Type)> scope,
            List<GStatement> prologue)
        {
            if (scope.Count == 1)
            {
                return new Parameter(SanitizeIdentifier(scope[0].Name), scope[0].Type);
            }

            // Issue #1998: G#'s tuple family (mirroring the BCL's `ValueTuple`)
            // tops out at arity 7 — a query scope this wide (`from` plus 6+
            // `let`/second-`from`/`join` clauses) has no canonical tuple to
            // widen into. Report a precise, actionable diagnostic HERE (rather
            // than silently emitting the oversized tuple shape, which would
            // only surface as an opaque GS0159 much later at G# bind time) and
            // still emit the best-effort shape so a single query with one
            // over-wide scope doesn't block translating the rest of the file.
            if (scope.Count > 7 && this.state.CurrentQueryNode != null)
            {
                string scopeMessage =
                    $"Query scope has grown to {scope.Count} range variables ({string.Join(", ", scope.Select(v => v.Name))}); " +
                    "G# tuples support at most 7 elements (ADR-0115 §B), so this scope has no canonical G# lowering. " +
                    "Split the query (e.g. an intermediate `select new { ... }`-style projection via a `let`, or a nested query) " +
                    "to keep each transparent-identifier scope at 7 or fewer range variables.";
                this.context.Report(new TranslationDiagnostic(
                    nameof(QueryExpressionSyntax),
                    scopeMessage,
                    this.state.CurrentQueryNode.GetLocation(),
                    TranslationSeverity.Unsupported));
            }

            // Issue #1998: guard against a `__qN` collision with EITHER a
            // range variable already in this scope OR any other user local
            // visible at the query (a user local literally named `__q0`
            // outside the query scope would otherwise still shadow/be
            // shadowed by the synthesized tuple parameter) — bump the counter
            // past any hit.
            string tupleParamName;
            do
            {
                tupleParamName = $"__q{this.state.QueryScopeCounter++}";
            }
            while (scope.Any(v => v.Name == tupleParamName) || this.IsNameVisibleAtCurrentQuery(tupleParamName));

            prologue.Add(new TupleDeconstructionStatement(
                BindingKind.Let,
                scope.Select(v => SanitizeIdentifier(v.Name)).ToList(),
                new IdentifierExpression(tupleParamName)));
            return new Parameter(tupleParamName, new TupleTypeReference(scope.Select(v => v.Type).ToList()));
        }

        // Issue #1998: whether `name` resolves to any symbol (local, parameter,
        // field, …) visible at the currently-lowering query's position, via the
        // active semantic model. Backs the `__qN` collision guard above —
        // `LookupSymbols` sees every C# local in scope at that source position,
        // not just the query's own range variables (`scope`).
        private bool IsNameVisibleAtCurrentQuery(string name)
        {
            if (this.state.CurrentQueryNode == null)
            {
                return false;
            }

            return this.context.SemanticModel
                .LookupSymbols(this.state.CurrentQueryNode.SpanStart, name: name)
                .Length > 0;
        }
    }
}
