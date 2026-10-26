// <copyright file="InterpolatedStringHandlerLowerer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Globalization
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Text
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Text
import System

/// Emit-time (IL-only) lowering of (cref:BoundInterpolatedStringExpression)
/// to the C# 10 interpolated-string-handler pattern, or to composite formatting
/// when the target framework does not provide that handler (issues #368/#3769,
/// ADR-0055).
/// @remarks When the target provides the default handler, each interpolation node is
/// rewritten into a (cref:BoundBlockExpression) that does the following.
/// 1. declares a `System.Runtime.CompilerServices.DefaultInterpolatedStringHandler` value-type local
/// and constructs it with `(literalLength, formattedCount)`.
/// 2. calls `AppendLiteral(string)` for each literal run and
/// `AppendFormatted<T>(value[, alignment][, format])` for each hole.
/// 3. yields `ToStringAndClear()` as the block's result.
/// The handler is a `ref struct`; in metadata it is an ordinary value type
/// (the `IsByRefLike` marker does not affect the local signature), so the
/// existing value-type local / instance-call emit paths handle it directly.
///
/// Value-type holes do <b>not</b> box: `AppendFormatted<T>` is closed
/// over the hole's concrete CLR type (or, for user-defined types lacking a
/// reflection (cref:System.Type), over an `object` placeholder while
/// the real type-argument symbol is encoded into the emitted MethodSpec), so the
/// hole value is passed by its natural representation.
///
/// When the target does not provide the default handler, ordinary string
/// interpolation instead lowers to `String.Format(string, object[])`.
/// That target-compatible path boxes value-type holes and preserves composite
/// formatting, alignment, evaluation order, and literal-brace escaping.
/// User-defined interpolated-string handlers are unaffected.
///
/// This rewrite is applied only on the emit path; the tree-walk interpreter
/// renders (cref:BoundInterpolatedStringExpression) directly.
internal class InterpolatedStringHandlerLowerer : NestedFunctionBodyRewriter {
    private let diagnostics DiagnosticBag = DiagnosticBag()
    private let references ReferenceResolver

    // Issue #3730/#3769: the DefaultInterpolatedStringHandler surface resolved
    // from the target reference closure. Null when the target does not declare
    // the required shape; ordinary string interpolation then uses String.Format.
    private let handler DefaultInterpolatedStringHandlerShape?

    private var counter int32
    private var stringFormat MethodInfo?

    private init(references ReferenceResolver) {
        this.references = references
        if DefaultInterpolatedStringHandlerShape.TryResolve(references, out var shape, out _) {
            this.handler = shape
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteInterpolatedStringExpression(
        node BoundInterpolatedStringExpression
    ) BoundExpression {
        var literalLength = 0
        var formattedCount = 0
        for part in node.Parts {
            if part.IsLiteral {
                literalLength += Invariant.Required(
                    part.Literal,
                    "a literal part is created by BoundInterpolatedStringPart.FromLiteral, which stores string.Empty rather than null",
                    expression: "part.Literal"
                )
                    .Length
            } else {
                formattedCount++
            }
        }
        if node.Handler != nil {
            return this.RewriteUserHandler(node, node.Handler, literalLength, formattedCount)
        }
        // Issue #3769: a handler supplied only by ReferenceResolver's host
        // fallback is not part of the target framework. Use the pre-C# 10
        // composite-format lowering instead of leaking System.Private.CoreLib
        // into the emitted assembly.
        if this.handler == nil {
            return this.RewriteStringFormat(node)
        }
        let handler = this.handler!!
        for part in node.Parts {
            if part.IsHole && TypeSymbol.IsByRefLike(part.Value!!.Type) &&
                FindByRefLikeToString(part.Value!!.Type) == nil {
                let location = part
                    .HoleSyntax
                    ?.Location ??
                    part.Value!!
                    .Syntax
                    ?.Location ??
                    node
                    .Syntax
                    ?.Location ??
                    default(TextLocation)
                this.diagnostics.ReportByRefLikeInterpolationUnsupported(location, part.Value!!.Type)
            }
        }
        let (parts, leading) = this.PrepareParts(node)
        let handlerLocal = LocalVariableSymbol(
            "<>interp${this.counter++}",
            isReadOnly: false,
            handler.HandlerTypeSymbol
        )
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        // Issue #368: hole values that contain an await are pre-evaluated into
        // temporaries here, before the ByRefLike handler is constructed, so no
        // handler local is live across an await suspension.
        statements.AddRange(leading)
        let construct = BoundClrConstructorCallExpression(
            node.Syntax,
            handler.HandlerType,
            handler.Constructor,
            ImmutableArray.Create[BoundExpression](
                BoundLiteralExpression(nil, literalLength),
                BoundLiteralExpression(nil, formattedCount)
            ),
            handler.HandlerTypeSymbol
        )
        statements.Add(BoundVariableDeclaration(node.Syntax, handlerLocal, construct))
        for part in parts {
            if part.IsLiteral {
                if Invariant.Required(
                    part.Literal,
                    "a literal part is created by BoundInterpolatedStringPart.FromLiteral, which stores string.Empty rather than null",
                    expression: "part.Literal"
                )
                    .Length == 0 {
                    continue
                }
                let append = BoundImportedInstanceCallExpression(
                    node.Syntax,
                    BoundVariableExpression(nil, handlerLocal),
                    handler.AppendLiteral,
                    TypeSymbol.Void,
                    ImmutableArray.Create[BoundExpression](BoundLiteralExpression(nil, part.Literal))
                )
                statements.Add(BoundExpressionStatement(node.Syntax, append))
                continue
            }
            var value = Invariant.Required(
                part.Value,
                "a formatted interpolated-string part has a bound value",
                expression: "part.Value"
            )
            let byRefLikeToString MethodInfo? = if TypeSymbol.IsByRefLike(value.Type) {
                FindByRefLikeToString(value.Type)
            } else {
                default(MethodInfo?)
            }
            if byRefLikeToString != nil {
                value = BoundImportedInstanceCallExpression(
                    node.Syntax,
                    value,
                    byRefLikeToString,
                    TypeSymbol.String,
                    ImmutableArray[BoundExpression].Empty
                )
            }
            if !this.TryCloseAppendFormatted(node, part, value.Type, out var method, out var typeArguments) {
                continue
            }
            let arguments = ImmutableArray.CreateBuilder[BoundExpression]()
            arguments.Add(value)
            if (part.Alignment != nil) {
                arguments.Add(BoundLiteralExpression(nil, part.Alignment))
            }
            if part.Format != nil {
                arguments.Add(BoundLiteralExpression(nil, part.Format))
            }
            let appendFormatted = BoundImportedInstanceCallExpression(
                node.Syntax,
                BoundVariableExpression(nil, handlerLocal),
                method!!,
                TypeSymbol.Void,
                arguments.ToImmutable(),
                argumentRefKinds: default(ImmutableArray[RefKind]),
                typeArgumentSymbols: ToNullableTypeArguments(typeArguments)
            )
            statements.Add(BoundExpressionStatement(node.Syntax, appendFormatted))
        }
        let result = BoundImportedInstanceCallExpression(
            node.Syntax,
            BoundVariableExpression(nil, handlerLocal),
            handler.ToStringAndClear,
            TypeSymbol.String,
            ImmutableArray[BoundExpression].Empty
        )
        return BoundBlockExpression(node.Syntax, statements.ToImmutable(), result)
    }

    private func RewriteStringFormat(node BoundInterpolatedStringExpression) BoundExpression {
        let (parts, leading) = this.PrepareParts(node)
        let format = StringBuilder()
        let arguments = ImmutableArray.CreateBuilder[BoundExpression]()
        for part in parts {
            if part.IsLiteral {
                AppendEscapedFormatLiteral(
                    format,
                    Invariant.Required(
                        part.Literal,
                        "a literal part is created by BoundInterpolatedStringPart.FromLiteral, which stores string.Empty rather than null",
                        expression: "part.Literal"
                    )
                )
                continue
            }
            var value = Invariant.Required(
                part.Value,
                "a formatted interpolated-string part has a bound value",
                expression: "part.Value"
            )
            if TypeSymbol.IsByRefLike(value.Type) {
                let toString MethodInfo? = FindByRefLikeToString(value.Type)
                if toString == nil {
                    this.diagnostics.ReportByRefLikeInterpolationUnsupported(
                        part
                            .HoleSyntax
                            ?.Location ??
                            value
                            .Syntax
                            ?.Location ??
                            node
                            .Syntax
                            ?.Location ??
                            default(TextLocation),
                        value.Type
                    )
                    return node
                }
                value = BoundImportedInstanceCallExpression(
                    node.Syntax,
                    value,
                    toString,
                    TypeSymbol.String,
                    ImmutableArray[BoundExpression].Empty
                )
            }
            let index = arguments.Count
            arguments.Add(
                if value.Type == TypeSymbol.Object {
                    value
                } else {
                    cast[BoundExpression](BoundConversionExpression(nil, TypeSymbol.Object, value))
                }
            )
            format.Append('{').Append(index.ToString(CultureInfo.InvariantCulture))
            if (part.Alignment != nil) {
                format.Append(',').Append(part.Alignment.ToString(CultureInfo.InvariantCulture))
            }
            if part.Format != nil {
                format.Append(':').Append(part.Format)
            }
            format.Append('}')
        }
        let argumentArray = BoundArrayCreationExpression(
            nil,
            ArrayTypeSymbol.Get(TypeSymbol.Object, arguments.Count),
            arguments.ToImmutable()
        )
        let result = BoundClrStaticCallExpression(
            node.Syntax,
            this.GetStringFormatMethod(),
            TypeSymbol.String,
            ImmutableArray.Create[BoundExpression](BoundLiteralExpression(nil, format.ToString()), argumentArray)
        )
        return if leading.IsEmpty {
            cast[BoundExpression](result)
        } else {
            cast[BoundExpression](BoundBlockExpression(node.Syntax, leading, result))
        }
    }

    private func GetStringFormatMethod() MethodInfo {
        if this.stringFormat != nil {
            return this.stringFormat!!
        }
        if !this.references.TryResolveType("System.String", requireExternalVisibility: false, out var stringType) ||
            !this
            .references
            .TryResolveType("System.Object", requireExternalVisibility: false, out var objectType) {
            throw InvalidOperationException("String.Format cannot be resolved from the target reference set.")
        }
        this.stringFormat = stringType!!.GetMethod(
            "Format",
            BindingFlags.Public | BindingFlags.Static,
            binder: nil,
            types: []Type{stringType!!, objectType!!.MakeArrayType()},
            modifiers: nil
        ) ??
            throw InvalidOperationException(
            "String.Format(string, object[]) cannot be resolved from the target reference set."
        )
        return this.stringFormat!!
    }

    /// Issue #975: rewrites the base-constructor-initializer argument lists held by
    /// the struct's primary constructor and every explicit constructor, lowering any
    /// interpolated strings (and other handled nodes) in `: base(args)` position
    /// the same way ordinary call arguments are lowered. Returns `true`
    /// when any initializer's arguments were rewritten.
    /// @param structSym The class whose constructor base initializers to lower.
    /// @returns `true` when at least one initializer changed.
    private func RewriteBaseInitializers(structSym StructSymbol) bool {
        var changed = false
        let primary BaseConstructorInitializer? = structSym.BaseConstructorInitializer
        if primary != nil && this.TryRewriteInitializerArguments(primary, out var loweredPrimary) {
            structSym.SetBaseConstructorInitializer(loweredPrimary!!)
            changed = true
        }
        for ctor in structSym.ExplicitConstructors {
            let init BaseConstructorInitializer? = ctor.BaseInitializer
            if init != nil && this.TryRewriteInitializerArguments(init, out var loweredInit) {
                ctor.SetBaseInitializer(loweredInit!!)
                changed = true
            }
        }
        return changed
    }

    /// Lowers each argument of [`initializer`](paramref). When any argument is
    /// rewritten, produces a replacement initializer targeting the same base
    /// constructor and reports it via [`rewritten`](paramref).
    /// @param initializer The base-constructor initializer to lower.
    /// @param rewritten The rewritten initializer when arguments changed; otherwise `null`.
    /// @returns `true` when the arguments were rewritten.
    private func TryRewriteInitializerArguments(
        initializer BaseConstructorInitializer,
        @NotNullWhen(true) out rewritten BaseConstructorInitializer?
    ) bool {
        rewritten = nil
        if initializer.Arguments.IsDefaultOrEmpty {
            return false
        }
        let builder = ImmutableArray.CreateBuilder[BoundExpression](initializer.Arguments.Length)
        var changed = false
        for argument in initializer.Arguments {
            let loweredArgument = this.RewriteExpression(argument)
            changed |= loweredArgument != argument
            builder.Add(loweredArgument)
        }
        if !changed {
            return false
        }
        rewritten = initializer.WithArguments(builder.ToImmutable())
        return true
    }

    /// Issue #368: when any interpolation hole contains an `await`, the hole
    /// values must be evaluated into temporaries <em>before</em> the (often
    /// ByRefLike) handler is constructed, so no handler local is live across an
    /// await suspension. Recursively lowers each hole value once, and — only when
    /// an await is present — emits leading `var tmp = value` declarations and
    /// rewrites the holes to read those temps. With no await present the parts are
    /// returned with their lowered values and no leading statements.
    /// @param node The interpolated-string node being lowered.
    /// @returns The prepared parts and any leading temp declarations.
    private func PrepareParts(node BoundInterpolatedStringExpression)(
        Parts ImmutableArray[BoundInterpolatedStringPart],
        Leading ImmutableArray[BoundStatement]
    ) {
        let lowered = ImmutableArray.CreateBuilder[BoundInterpolatedStringPart](node.Parts.Length)
        var anyAwait = false
        for part in node.Parts {
            if part.IsLiteral {
                lowered.Add(part)
                continue
            }
            let value = this.RewriteExpression(part.Value!!)
            anyAwait |= AsyncBoundTreeQueries.HasAwait(value)
            lowered.Add(part.WithValue(value))
        }
        if !anyAwait {
            return (lowered.ToImmutable(), ImmutableArray[BoundStatement].Empty)
        }
        let leading = ImmutableArray.CreateBuilder[BoundStatement]()
        let prepared = ImmutableArray.CreateBuilder[BoundInterpolatedStringPart](node.Parts.Length)
        for part in lowered {
            if part.IsLiteral {
                prepared.Add(part)
                continue
            }
            let tmp = LocalVariableSymbol("<>hole${this.counter++}", isReadOnly: false, part.Value!!.Type)
            leading.Add(BoundVariableDeclaration(nil, tmp, part.Value))
            prepared.Add(part.WithValue(BoundVariableExpression(nil, tmp)))
        }
        return (prepared.ToImmutable(), leading.ToImmutable())
    }

    /// Issue #418 (P1-9): for user handlers that require a per-append gate
    /// (`out bool shouldAppend` or bool-returning append methods), each
    /// hole expression must be evaluated lazily inside the gated block. This
    /// helper recursively lowers each hole value <em>without</em> pre-spilling
    /// to leading temps; awaiting holes are spilled into temps inside the gated
    /// block by (cref:MakeAppendStatement).
    private func LowerHoleValuesInPlace(node BoundInterpolatedStringExpression) ImmutableArray[
        BoundInterpolatedStringPart
    ] {
        let lowered = ImmutableArray.CreateBuilder[BoundInterpolatedStringPart](node.Parts.Length)
        for part in node.Parts {
            if part.IsLiteral {
                lowered.Add(part)
                continue
            }
            lowered.Add(part.WithValue(this.RewriteExpression(part.Value!!)))
        }
        return lowered.ToImmutable()
    }

    /// Issue #368: lowers an interpolated string targeting a user-defined
    /// `[InterpolatedStringHandler]` parameter. Constructs the handler with
    /// `(literalLength, formattedCount, ...forwarded args [, out bool shouldAppend])`,
    /// appends each part, and yields the constructed handler value itself (not
    /// `ToStringAndClear()`) so the receiving API consumes the handler.
    private func RewriteUserHandler(
        node BoundInterpolatedStringExpression,
        info InterpolatedStringHandlerInfo,
        literalLength int32,
        formattedCount int32
    ) BoundExpression {
        let handlerClrType = info.HandlerClrType
        let handlerSymbol = info.HandlerType
        let handlerLocal = LocalVariableSymbol("<>interp${this.counter++}", isReadOnly: false, handlerSymbol)
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let appendLiteral = FindAppendLiteral(handlerClrType)
        // Issue #418 (P1-9): when the handler ctor produces an `out bool shouldAppend`
        // or some append method returns `bool`, every per-append call (including
        // evaluation of the hole expression) must be gated behind that running
        // condition. The spec requires lazy evaluation of holes — setting
        // shouldAppend = false in the ctor must skip both the AppendFormatted call
        // and the side effects of the hole expression itself (e.g. an `await`).
        let appendsReturnBool = AppendsReturnBool(handlerClrType, appendLiteral)
        let needsGate = info.HasTrailingOutBool || appendsReturnBool
        // When gating is needed we cannot pre-spill holes into leading temps
        // because that evaluates them before the ctor decides shouldAppend.
        // Instead, recursively lower the hole values in place and defer any
        // await-spill into the gated block (see MakeAppendStatement). Without
        // gating, the existing PrepareParts pre-spill preserves ref-struct
        // safety across awaits.
        var parts ImmutableArray[BoundInterpolatedStringPart]
        if needsGate {
            parts = this.LowerHoleValuesInPlace(node)
        } else {
            var leading ImmutableArray[BoundStatement]
            parts, leading = this.PrepareParts(node)
            statements.AddRange(leading)
        }
        // Build the constructor argument list: (literalLength, formattedCount,
        // ...forwarded args [, &shouldAppend]).
        let ctorArgs = ImmutableArray.CreateBuilder[BoundExpression]()
        ctorArgs.Add(BoundLiteralExpression(nil, literalLength))
        ctorArgs.Add(BoundLiteralExpression(nil, formattedCount))
        for forwarded in info.ForwardedArguments {
            ctorArgs.Add(this.RewriteExpression(forwarded))
        }
        var shouldAppendLocal LocalVariableSymbol? = nil
        var ctorRefKinds = default(ImmutableArray[RefKind])
        if info.HasTrailingOutBool {
            shouldAppendLocal = LocalVariableSymbol("<>shouldAppend${this.counter}", isReadOnly: false, TypeSymbol.Bool)
            this.counter++
            statements.Add(BoundVariableDeclaration(nil, shouldAppendLocal, BoundLiteralExpression(nil, false)))
            ctorArgs.Add(BoundAddressOfExpression(nil, BoundVariableExpression(nil, shouldAppendLocal)))
            let refKinds = ImmutableArray.CreateBuilder[RefKind](ctorArgs.Count)
            for var i = 0; i < ctorArgs.Count - 1; i++ {
                refKinds.Add(RefKind.None)
            }
            refKinds.Add(RefKind.Out)
            ctorRefKinds = refKinds.MoveToImmutable()
        }
        let construct = BoundClrConstructorCallExpression(
            node.Syntax,
            handlerClrType,
            info.Constructor,
            ctorArgs.ToImmutable(),
            handlerSymbol,
            ctorRefKinds
        )
        statements.Add(BoundVariableDeclaration(node.Syntax, handlerLocal, construct))
        var continueLocal LocalVariableSymbol? = nil
        if needsGate {
            continueLocal = LocalVariableSymbol("<>cont${this.counter}", isReadOnly: false, TypeSymbol.Bool)
            this.counter++
            let seed BoundExpression = if shouldAppendLocal != nil {
                cast[BoundExpression](BoundVariableExpression(nil, shouldAppendLocal))
            } else {
                cast[BoundExpression](BoundLiteralExpression(nil, true))
            }
            statements.Add(BoundVariableDeclaration(nil, continueLocal, seed))
        }
        for part in parts {
            var appendCall BoundExpression
            if part.IsLiteral {
                if Invariant.Required(
                    part.Literal,
                    "a literal part is created by BoundInterpolatedStringPart.FromLiteral, which stores string.Empty rather than null",
                    expression: "part.Literal"
                )
                    .Length == 0 {
                    continue
                }
                appendCall = BoundImportedInstanceCallExpression(
                    node.Syntax,
                    BoundVariableExpression(nil, handlerLocal),
                    appendLiteral,
                    ClrNullability.GetReturnTypeSymbol(appendLiteral),
                    ImmutableArray.Create[BoundExpression](BoundLiteralExpression(nil, part.Literal))
                )
            } else {
                var value = part.Value
                // Issue #418: when gating, an await inside the hole must not run
                // before the gate is checked. Defer the spill into the gated block
                // so the temp is initialized only when the gate allows the append.
                var holeLeading = ImmutableArray[BoundStatement].Empty
                if needsGate && AsyncBoundTreeQueries.HasAwait(value!!) {
                    let holeTmp = LocalVariableSymbol("<>hole${this.counter++}", isReadOnly: false, value!!.Type)
                    holeLeading = ImmutableArray.Create[BoundStatement](BoundVariableDeclaration(nil, holeTmp, value))
                    value = BoundVariableExpression(nil, holeTmp)
                }
                if !InterpolatedStringHandlerInfo.TryResolveAppendFormatted(
                    handlerClrType,
                    part,
                    value!!.Type,
                    out var method,
                    out var typeArguments
                ) {
                    throw InvalidOperationException(
                        "Interpolated-string handler '${handlerClrType.Name}' was lowered without a compatible AppendFormatted method."
                    )
                }
                let arguments = ImmutableArray.CreateBuilder[BoundExpression]()
                arguments.Add(value!!)
                if (part.Alignment != nil) {
                    arguments.Add(BoundLiteralExpression(nil, part.Alignment))
                }
                if part.Format != nil {
                    arguments.Add(BoundLiteralExpression(nil, part.Format))
                }
                appendCall = BoundImportedInstanceCallExpression(
                    node.Syntax,
                    BoundVariableExpression(nil, handlerLocal),
                    method,
                    ClrNullability.GetReturnTypeSymbol(method),
                    arguments.ToImmutable(),
                    argumentRefKinds: default(ImmutableArray[RefKind]),
                    typeArgumentSymbols: ToNullableTypeArguments(typeArguments)
                )
                statements.Add(this.MakeAppendStatement(node.Syntax, appendCall, continueLocal, holeLeading))
                continue
            }
            statements.Add(this.MakeAppendStatement(node.Syntax, appendCall, continueLocal))
        }
        let resultValue = BoundVariableExpression(nil, handlerLocal)
        // Issue #377 sub-item 1: a byref handler-typed parameter consumes
        // the address of the constructed handler local. Wrap the trailing
        // value with an address-of so EmitBlockExpression emits `ldloca` for
        // the by-ref / in / out slot. (The emitter falls back to the block
        // expression itself for byref slots and re-emits its trailing
        // expression directly.)
        var trailing BoundExpression = resultValue
        if info.HandlerRefKind != RefKind.None {
            trailing = BoundAddressOfExpression(node.Syntax, resultValue)
        }
        return BoundBlockExpression(node.Syntax, statements.ToImmutable(), trailing)
    }

    /// Wraps a single append call so it runs only while the short-circuit
    /// condition ([`continueLocal`](paramref)) is still `true`. When
    /// the append returns `bool` its result updates the condition. When no
    /// gating is required the call is emitted unconditionally.
    ///
    /// Issue #418 (P1-9): any [`holeLeading`](paramref) statements
    /// (hole-evaluation spills produced for awaiting holes when gating is in
    /// effect) are emitted <em>inside</em> the gated block so the hole
    /// expression is evaluated only when the gate allows the append.
    private func MakeAppendStatement(
        syntax SyntaxNode?,
        appendCall BoundExpression,
        continueLocal LocalVariableSymbol?,
        holeLeading ImmutableArray[BoundStatement] = default(ImmutableArray[BoundStatement])
    ) BoundStatement {
        let returnsBool = appendCall.Type?.ClrType.IsSameAs(typeof(bool)) == true
        let leading = if holeLeading.IsDefault {
            ImmutableArray[BoundStatement].Empty
        } else {
            holeLeading
        }
        if continueLocal == nil {
            if leading.IsEmpty {
                return BoundExpressionStatement(syntax, appendCall)
            }
            let unguarded = ImmutableArray.CreateBuilder[BoundStatement](leading.Length + 1)
            unguarded.AddRange(leading)
            unguarded.Add(BoundExpressionStatement(syntax, appendCall))
            return BoundBlockStatement(syntax, unguarded.ToImmutable())
        }
        let inner BoundStatement = if returnsBool {
            BoundExpressionStatement(syntax, BoundAssignmentExpression(nil, continueLocal, appendCall))
        } else {
            BoundExpressionStatement(syntax, appendCall)
        }
        // Emit already-flattened control flow (conditional goto + label) because
        // this lowering pass runs after the binder's if->goto rewrite, so a
        // BoundIfStatement introduced here would never be lowered for emit:
        //
        //   gotoFalse <>cont end
        //   [hole-leading spills (issue #418)]
        //   <append (maybe assigns <>cont)>
        //   end:
        let endLabel = BoundLabel("<>appendEnd${this.counter++}")
        let gotoFalse = BoundConditionalGotoStatement(
            nil,
            endLabel,
            BoundVariableExpression(nil, continueLocal),
            jumpIfTrue: false
        )
        let endLabelStatement = BoundLabelStatement(nil, endLabel)
        let block = ImmutableArray.CreateBuilder[BoundStatement](2 + leading.Length + 1)
        block.Add(gotoFalse)
        block.AddRange(leading)
        block.Add(inner)
        block.Add(endLabelStatement)
        return BoundBlockStatement(syntax, block.ToImmutable())
    }

    private func RewriteFieldInitializers(structSym StructSymbol) bool {
        var changed = false
        let staticInitializers = structSym.StaticFieldInitializers.ToBuilder()
        for pair in BoundProgramOrder.FieldInitializers(structSym.StaticFieldInitializers) {
            let rewritten = this.RewriteExpression(pair.Value)
            staticInitializers[pair.Key] = rewritten
            changed |= rewritten != pair.Value
        }
        structSym.SetStaticFieldInitializers(staticInitializers.ToImmutable())
        let instanceInitializers = structSym.InstanceFieldInitializers.ToBuilder()
        for pair in BoundProgramOrder.FieldInitializers(structSym.InstanceFieldInitializers) {
            let rewritten = this.RewriteExpression(pair.Value)
            instanceInitializers[pair.Key] = rewritten
            changed |= rewritten != pair.Value
        }
        structSym.SetInstanceFieldInitializers(instanceInitializers.ToImmutable())
        return changed
    }

    /// Issue #3730: picks the `AppendFormatted<T>` overload the hole's
    /// decorations need <em>from the target framework's handler</em> and closes it
    /// over the hole's CLR type. Returns `false` — having reported
    /// GS0545 — when the target does not declare that overload, rather than
    /// emitting a call the target's runtime cannot resolve.
    /// @param node The interpolation being lowered, for diagnostic anchoring.
    /// @param part The hole whose alignment/format decorations select the overload.
    /// @param holeType The hole's type.
    /// @param method The closed `AppendFormatted`.
    /// @param typeArguments The symbolic type arguments the emitter must encode, when the hole has no
    /// reflection type.
    /// @returns `true` when an overload was available.
    private func TryCloseAppendFormatted(
        node BoundInterpolatedStringExpression,
        part BoundInterpolatedStringPart,
        holeType TypeSymbol,
        @NotNullWhen(true) out method MethodInfo?,
        out typeArguments ImmutableArray[TypeSymbol]
    ) bool {
        let shape = Invariant.Required(
            this.handler,
            "the handler shape is resolved before any part is lowered",
            expression: "this.handler"
        )
        let (open_, signature) = shape.GetAppendFormatted((part.Alignment != nil), part.Format != nil)
        if open_ == nil {
            method = nil
            typeArguments = default(ImmutableArray[TypeSymbol])
            this.diagnostics.ReportInterpolatedStringHandlerUnavailable(
                part
                    .HoleSyntax
                    ?.Location ??
                    part
                    .Value
                    ?.Syntax
                    ?.Location ??
                    node
                    .Syntax
                    ?.Location ??
                    default(TextLocation),
                signature
            )
            return false
        }
        // Issue #1916: a `T?` hole over a value type must close over
        // `Nullable<T>`, not the bare `TypeSymbol.ClrType` (which is the
        // underlying `T` per NullableTypeSymbol's ctor) — the value pushed on
        // the stack for a nullable-typed local/expression is the full
        // `Nullable<T>` struct, so closing the generic method over `T` leaves
        // a StackUnexpected mismatch at the call site (found Nullable<T>,
        // expected T). GetEffectiveClrType returns `Nullable<T>` for
        // value-type nullables and `holeType.ClrType` for everything else.
        let clrType Type? = NullableTypeSymbol.GetEffectiveClrType(holeType)
        if clrType != nil {
            // Primitive / BCL / reference holes close over their concrete CLR
            // type, so a value-type hole is passed without boxing.
            method = shape.CloseAppendFormatted(open_, clrType)
            typeArguments = default(ImmutableArray[TypeSymbol])
            return true
        }
        // A user-defined type has no reflection Type; close over an object
        // placeholder and carry the real type-argument symbol so the emitter
        // encodes the user TypeDef into the MethodSpec (issue #320 path).
        method = shape.CloseAppendFormatted(open_, typeof(object))
        typeArguments = ImmutableArray.Create(holeType)
        return true
    }

    shared {
        /// Lowers one body for the canonical async lifetime proof.
        /// @param body The body after suspending-call rewriting.
        /// @param references The compilation's reference closure.
        /// @returns The body with actual handler append lifetimes.
        internal func LowerBody(body BoundBlockStatement, references ReferenceResolver) BoundBlockStatement ->
        cast[BoundBlockStatement](InterpolatedStringHandlerLowerer(references).RewriteStatement(body))

        /// Produces a copy of [`program`](paramref) in which every interpolated
        /// string has been lowered to the handler pattern. Returns the original
        /// instance unchanged when no interpolation is present.
        /// @param program The bound program to lower.
        /// @param references The compilation's reference closure. Issue #3730: the handler surface the
        /// lowering targets is resolved from here, so it describes the framework
        /// being compiled against rather than the SDK hosting `gsc`.
        /// @returns The lowered program.
        func Lower(program BoundProgram, references ReferenceResolver) BoundProgram {
            let lowerer = InterpolatedStringHandlerLowerer(references)
            var changed = false
            let functions = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
            // Issue #4663: deterministic order, never identity-hash order.
            for pair in BoundProgramOrder.Functions(program) {
                let newBody = cast[BoundBlockStatement](lowerer.RewriteStatement(pair.Value))
                functions[pair.Key] = newBody
                changed |= newBody != pair.Value
            }
            let statement = cast[BoundBlockStatement](lowerer.RewriteStatement(program.Statement))
            changed |= statement != program.Statement
            // Issue #975: base-constructor-initializer arguments (`: base(args)`) are
            // stored on the constructor / struct symbols rather than inside a method
            // body, so they bypass the function-body rewrite above. Lower any
            // interpolated strings sitting in that position too, otherwise the emitter
            // meets a raw BoundInterpolatedStringExpression and ICEs (GS9998). The
            // symbols are mutated in place; emission re-runs binding for each call, so
            // sharing across the discarded pre-lowering program is harmless.
            for structSym in program.Structs {
                changed |= lowerer.RewriteBaseInitializers(structSym)
                changed |= lowerer.RewriteFieldInitializers(structSym)
            }
            for interfaceSym in program.Interfaces {
                let initializers = interfaceSym.StaticFieldInitializers.ToBuilder()
                for pair in BoundProgramOrder.FieldInitializers(interfaceSym.StaticFieldInitializers) {
                    let rewritten = lowerer.RewriteExpression(pair.Value)
                    initializers[pair.Key] = rewritten
                    changed |= rewritten != pair.Value
                }
                interfaceSym.SetStaticFieldInitializers(initializers.ToImmutable())
            }
            let diagnostics = program.Diagnostics.AddRange(lowerer.diagnostics.ToImmutableArray())
            if !changed && diagnostics.Length == program.Diagnostics.Length {
                return program
            }
            let result = BoundProgram(
                program.EntryPointPackage,
                program.Packages,
                diagnostics,
                functions.ToImmutable(),
                program.EntryPoint,
                statement,
                program.Structs,
                program.Interfaces,
                program.Enums,
                program.Globals,
                program.Delegates
            ){
                Imports = program.Imports,
                FriendAssemblies = program.FriendAssemblies,
                AssemblyAttributes = program.AssemblyAttributes,
                ModuleAttributes = program.ModuleAttributes,
                NativeProtocols = program.NativeProtocols
            }
            return result
        }

        private func AppendEscapedFormatLiteral(builder StringBuilder, text string) {
            for character in text {
                if character == '{' || character == '}' {
                    builder.Append(character)
                }
                builder.Append(character)
            }
        }

        private func FindAppendLiteral(
            handlerType Type
        ) MethodInfo -> if InterpolatedStringHandlerInfo.TryResolveAppendLiteral(handlerType, out var method) {
            method!!
        } else {
            throw InvalidOperationException(
                "Interpolated-string handler '${handlerType.Name}' has no AppendLiteral(string) method."
            )
            default(MethodInfo)
        }

        private func AppendsReturnBool(handlerType Type, appendLiteral MethodInfo) bool {
            if appendLiteral.ReturnType.IsSameAs(typeof(bool)) {
                return true
            }
            for method in handlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                if method.Name == "AppendFormatted" && method.ReturnType.IsSameAs(typeof(bool)) {
                    return true
                }
            }
            return false
        }

        private func FindByRefLikeToString(type TypeSymbol) MethodInfo? -> type?.ClrType?.GetMethodSafe(
            "ToString",
            Type.EmptyTypes
        )

        private func ToNullableTypeArguments(typeArguments ImmutableArray[TypeSymbol]) ImmutableArray[
            TypeSymbol?
        ] -> if typeArguments.IsDefault {
            default(ImmutableArray[TypeSymbol?])
        } else {
            typeArguments.Select((typeArgument TypeSymbol) -> cast[TypeSymbol?](typeArgument)).ToImmutableArray()
        }
    }
}
