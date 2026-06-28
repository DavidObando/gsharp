// <copyright file="ExpressionBinder.Access.Indexing.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
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
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{


    private BoundExpression BindIndexExpression(IndexExpressionSyntax syntax)
    {
        if (syntax.IsNullConditional)
        {
            // ADR-0073 / issue #710: `a?[i]` evaluates `a` once; if nil, the
            // whole expression is nil (without touching the indexer or the
            // index operand). Otherwise it indexes the captured value once.
            return BindNullConditionalIndexExpression(syntax);
        }

        var target = BindExpression(syntax.Target);
        return BindIndexAgainstTarget(target, syntax.Index, syntax.Target.Location);
    }

    // ADR-0073 / issue #710: bind `target?[index]`. The receiver is evaluated
    // exactly once into a synthetic capture local; the indexed access is then
    // bound against the capture and wrapped in a
    // BoundNullConditionalAccessExpression so the existing lowering and emit
    // pipeline (which already handles `?.`) covers the new form for free.
    private BoundExpression BindNullConditionalIndexExpression(IndexExpressionSyntax syntax)
    {
        var receiver = BindExpression(syntax.Target);
        if (receiver is BoundErrorExpression)
        {
            return receiver;
        }

        return BindNullConditionalIndexFromBoundTarget(receiver, syntax);
    }

    // ADR-0073 / issue #710: shared core for `?[i]` binding. Splits the
    // already-bound receiver into capture + indexed access so nested
    // accessor-chain entry points (e.g. the `IndexExpressionSyntax` case in
    // BindAccessorStep that handles `a.b?[i]`) can reuse the same logic.
    private BoundExpression BindNullConditionalIndexFromBoundTarget(BoundExpression receiver, IndexExpressionSyntax syntax)
    {
        var receiverType = receiver.Type;
        TypeSymbol underlying;
        if (receiverType is NullableTypeSymbol nullable)
        {
            underlying = nullable.UnderlyingType;
        }
        else if (receiverType == TypeSymbol.Null)
        {
            // `nil?[i]` is statically nil.
            return new BoundLiteralExpression(null, null);
        }
        else
        {
            // GS0300 (warning): the receiver of `?[...]` is non-nullable, so
            // the null-check is dead code. Suggest the plain `[...]` form.
            Diagnostics.ReportNullConditionalIndexReceiverNotNullable(
                syntax.OpenBracketToken.Location,
                receiverType);
            underlying = receiverType;
        }

        var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: underlying);

        // Push a temp scope so the capture is in scope while we bind the
        // indexed access against it.
        scope = new BoundScope(scope);
        scope.TryDeclareVariable(capture);

        var captureRef = new BoundVariableExpression(null, capture);
        var whenNotNull = BindIndexAgainstTarget(captureRef, syntax.Index, syntax.Target.Location);

        scope = scope.Parent;

        if (whenNotNull is BoundErrorExpression || whenNotNull.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var resultType = whenNotNull.Type is NullableTypeSymbol
            ? whenNotNull.Type
            : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);

        LocalVariableSymbol resultSlot = null;
        if (resultType is NullableTypeSymbol nullableResult
            && nullableResult.UnderlyingType?.ClrType is { IsValueType: true })
        {
            var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
            resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
        }

        return new BoundNullConditionalAccessExpression(null, receiver, capture, whenNotNull, resultType, resultSlot);
    }

    private BoundExpression BindIndexAgainstTarget(BoundExpression target, ExpressionSyntax indexSyntax, TextLocation targetLocation)
    {
        // ADR-0122 / issue #1014: pointer indexing `p[i]` == `*(p + i)`.
        if (target.Type is PointerTypeSymbol pointerTarget)
        {
            // ADR-0122 §3 / issue #1033: a `*void` pointer has no element type,
            // so `p[i]` (which lowers to `*(p + i)`) is rejected (GS0403); cast
            // to a typed pointer `*T` first.
            if (TypeSymbol.IsVoidPointer(target.Type))
            {
                Diagnostics.ReportVoidPointerOperationNotAllowed(targetLocation, "index");
                return new BoundErrorExpression(null);
            }

            var pointerIndex = BindExpression(indexSyntax);
            if (pointerIndex is BoundErrorExpression)
            {
                return pointerIndex;
            }

            if (!IsPointerOffsetType(pointerIndex.Type))
            {
                pointerIndex = conversions.BindConversion(indexSyntax, TypeSymbol.NInt);
            }

            var elementPointer = LowerPointerOffset(target, pointerTarget, pointerIndex, subtract: false);
            return new BoundDereferenceExpression(null, elementPointer);
        }

        // Issue #1016: a range operand (`a[lo..hi]`) slices the target rather
        // than indexing a single element.
        if (indexSyntax is RangeExpressionSyntax rangeSyntax)
        {
            return BindRangeSlice(target, rangeSyntax, targetLocation);
        }

        // Issue #1022: a from-end index (`a[^n]`) reads the single element
        // `length - n`.
        if (indexSyntax is FromEndIndexExpressionSyntax fromEndSyntax)
        {
            return BindFromEndIndex(target, fromEndSyntax, targetLocation);
        }

        // Issue #1038: an index whose value is a `System.Range` slices the
        // target (`let r = 1..3; a[r]`, or the inline `a[(1..3)]`), dispatching
        // to the same array/string/span/`this[System.Range]` shapes used by the
        // syntactic `a[1..3]` form. Bind the index once here and reuse the bound
        // expression in the ordinary index paths below to avoid re-binding.
        // `default`/interpolated index syntaxes can never be a range value and
        // keep their dedicated conversion handling, so they are not pre-bound.
        BoundExpression boundIndex = null;
        if (indexSyntax is not DefaultExpressionSyntax && indexSyntax is not InterpolatedStringExpressionSyntax)
        {
            boundIndex = BindExpression(indexSyntax);
            if (boundIndex is BoundErrorExpression)
            {
                return boundIndex;
            }

            if (IsSystemRangeType(boundIndex.Type))
            {
                return BindRangeValueSlice(target, boundIndex, targetLocation);
            }
        }

        BoundExpression ConvertIndex(TypeSymbol conversionTargetType) =>
            boundIndex != null
                ? conversions.BindConversion(indexSyntax.Location, boundIndex, conversionTargetType)
                : conversions.BindConversion(indexSyntax, conversionTargetType);

        BoundExpression BoundIndexArg() => boundIndex ?? BindExpression(indexSyntax);

        // Phase 3.A.4: map indexing `m[k]` — key bound to K, result type V.
        // The Go convention "zero value if missing" applies at evaluation;
        // the bound representation reuses BoundIndexExpression with the
        // element type set to V.
        if (target.Type is MapTypeSymbol mapType)
        {
            var key = ConvertIndex(mapType.KeyType);
            return new BoundIndexExpression(null, target, key, mapType.ValueType);
        }

        var element = GetIndexElementType(target.Type);
        if (element != null)
        {
            // Issue #1279: array/slice element access accepts any integer-typed
            // index (matching C#). `boundIndex` is non-null for every non-
            // default/interpolated index; those two carry no natural type and
            // keep the historical int32 conversion driven by the target type.
            var index = boundIndex != null
                ? ConvertArrayElementIndex(indexSyntax.Location, boundIndex)
                : ConvertIndex(TypeSymbol.Int32);
            return new BoundIndexExpression(null, target, index, element);
        }

        // Issue #1129: `string` is the primitive `TypeSymbol.String` (not an
        // `ImportedTypeSymbol`), so it matches none of the indexer-resolution
        // branches below. Model `s[i]` against .NET's `String` indexer
        // (`char this[int]` / `get_Chars(int)`), yielding a `char`. Issue #1279:
        // any integer-typed index is accepted; because `get_Chars` takes an
        // int32, the wider integer types convert (narrow) to int32. Emit already
        // lowers a `BoundIndexExpression` whose target is `string` to `get_Chars`
        // (#537).
        if (target.Type == TypeSymbol.String)
        {
            var index = boundIndex != null
                ? ConvertStringCharIndex(indexSyntax.Location, boundIndex)
                : ConvertIndex(TypeSymbol.Int32);
            return new BoundIndexExpression(null, target, index, TypeSymbol.Char);
        }

        // Phase 4 exit: CLR indexer read on an imported reference type
        // (e.g. `d["k"]` on Dictionary[string, int]). Pick a public
        // instance indexer (a `PropertyInfo` whose `GetIndexParameters()`
        // matches the single argument by assignability).
        // Issue #209: when the target carries inner-position nullable flags,
        // use them to type the element correctly (e.g., `list[0]` on `List<string?>` → `string?`).
        if (target.Type is NullabilityAnnotatedTypeSymbol annotIdx && annotIdx.ClrType is System.Type clrAnnotIdx)
        {
            var idxArgsAnnot = ImmutableArray.Create(BoundIndexArg());
            if (this.memberLookup.TryResolveClrIndexer(clrAnnotIdx, idxArgsAnnot, out var idxPropAnnot))
            {
                var elemTypeAnnot = annotIdx.GetTypeArgumentSymbolForClrType(idxPropAnnot.PropertyType);
                return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrIndexExpression(null, target, idxPropAnnot, idxArgsAnnot, elemTypeAnnot));
            }
        }
        else if (target.Type is ImportedTypeSymbol && target.Type.ClrType is System.Type clrTarget)
        {
            var idxArgs = ImmutableArray.Create(BoundIndexArg());
            if (this.memberLookup.TryResolveClrIndexer(clrTarget, idxArgs, out var idxProp))
            {
                var elementType = MapErasedIndexerElementType((ImportedTypeSymbol)target.Type, idxProp);
                return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrIndexExpression(null, target, idxProp, idxArgs, elementType));
            }
        }

        // ADR-0118 / issue #944: index access on a user-defined type that
        // declares an indexer member (`prop this[i T] U`). Binds `obj[i]` to a
        // call of the indexer getter (`obj.get_Item(i)`).
        if (target.Type is StructSymbol userIndexTarget
            && TryGetUserIndexer(userIndexTarget, out var readIndexer, out var readSubstitution)
            && readIndexer.Parameters.Length == 1)
        {
            if (readIndexer.GetterSymbol == null)
            {
                Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
                return new BoundErrorExpression(null);
            }

            var paramType = readSubstitution != null
                ? Binder.SubstituteType(readIndexer.Parameters[0].Type, readSubstitution)
                : readIndexer.Parameters[0].Type;
            var indexArg = ConvertIndex(paramType);
            var elementType = readSubstitution != null
                ? Binder.SubstituteType(readIndexer.Type, readSubstitution)
                : readIndexer.Type;
            return new BoundUserInstanceCallExpression(
                null,
                target,
                readIndexer.GetterSymbol,
                ImmutableArray.Create(indexArg),
                elementType);
        }

        if (target.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
        }

        return new BoundErrorExpression(null);
    }

    private BoundExpression BindIndexedWriteThroughChain(
        BoundExpression chainBase,
        ExpressionSyntax remainingChain,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        BoundExpression boundValueOverride,
        SyntaxToken compoundOperatorToken,
        ExpressionSyntax compoundRhsSyntax,
        TextLocation diagnosticLocation,
        SyntaxNode outerSyntax)
    {
        if (TrySplitAtLeftmostNullConditional(remainingChain, out var leftSyntax, out var rightSyntax))
        {
            BoundExpression boundLeft = chainBase == null
                ? BindExpression(leftSyntax)
                : BindAccessorStep(chainBase, null, leftSyntax);
            if (boundLeft is BoundErrorExpression || boundLeft.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            TypeSymbol underlying;
            if (boundLeft.Type is NullableTypeSymbol nullable)
            {
                underlying = nullable.UnderlyingType;
            }
            else if (boundLeft.Type == TypeSymbol.Null)
            {
                // Statically nil receiver: assignment is a no-op. Produce a
                // bound literal null so the surrounding expression sees a
                // well-typed value; lowering treats `null` literals as
                // statement-position no-ops.
                return new BoundLiteralExpression(null, null);
            }
            else
            {
                // Non-nullable receiver: `?.` degenerates to `.`, but we still
                // produce a nullable result type for syntactic consistency
                // with the read-side null-conditional path.
                underlying = boundLeft.Type;
            }

            var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: underlying);
            scope = new BoundScope(scope);
            scope.TryDeclareVariable(capture);

            var captureRef = new BoundVariableExpression(null, capture);
            var whenNotNull = BindIndexedWriteThroughChain(
                chainBase: captureRef,
                remainingChain: rightSyntax,
                indexSyntax,
                valueSyntax,
                boundValueOverride,
                compoundOperatorToken,
                compoundRhsSyntax,
                diagnosticLocation,
                outerSyntax);

            scope = scope.Parent;

            if (whenNotNull is BoundErrorExpression)
            {
                return whenNotNull;
            }

            var resultType = whenNotNull.Type is NullableTypeSymbol
                ? whenNotNull.Type
                : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);

            LocalVariableSymbol resultSlot = null;
            if (resultType is NullableTypeSymbol nullableResult
                && nullableResult.UnderlyingType?.ClrType is { IsValueType: true })
            {
                var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
                resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
            }

            return new BoundNullConditionalAccessExpression(null, boundLeft, capture, whenNotNull, resultType, resultSlot);
        }

        BoundExpression boundReceiver = chainBase == null
            ? BindExpression(remainingChain)
            : BindAccessorStep(chainBase, null, remainingChain);
        if (boundReceiver is BoundErrorExpression || boundReceiver.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var tempName = $"<idxAsn{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, boundReceiver.Type);
        if (!scope.TryDeclareVariable(tempVar))
        {
            // Defensive: synthesized names cannot collide with user identifiers
            // (the `<...>` prefix is not a valid identifier token), so a failure
            // here means a duplicate synthesized name within the same scope,
            // which Interlocked.Increment guarantees against. Treat as fatal.
            throw new System.InvalidOperationException(
                $"Failed to declare synthesized index-assignment target local '{tempName}'.");
        }

        var declaration = new BoundVariableDeclaration(outerSyntax, tempVar, boundReceiver);

        BoundExpression assignment;
        if (compoundOperatorToken != null)
        {
            if (!SyntaxFacts.TryGetCompoundAssignmentBaseOperator(compoundOperatorToken.Kind, out var baseOpKind))
            {
                // Defensive: parser only emits this node for kinds recognised
                // by TryGetCompoundAssignmentBaseOperator above.
                return new BoundErrorExpression(null);
            }

            var tempRef = new BoundVariableExpression(null, tempVar);
            var indexRead = BindIndexAgainstTarget(tempRef, indexSyntax, diagnosticLocation);
            if (indexRead is BoundErrorExpression)
            {
                return indexRead;
            }

            var rhsBound = BindExpression(compoundRhsSyntax);
            if (rhsBound is BoundErrorExpression || rhsBound.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            // issue #1226 / #1246: the right operand of a compound element/indexer
            // assignment (`data[i] op= v`, including the synthetic `1` for
            // `++`/`--`) participates in the SAME constant-integer-literal
            // adaptation and implicit numeric widening as the equivalent binary
            // `data[i] op v`, via the shared adaptation helper.
            var combined = TryBindCompoundBinaryOperation(baseOpKind, indexRead, rhsBound, compoundRhsSyntax.Location);
            if (combined == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(
                    compoundOperatorToken.Location,
                    compoundOperatorToken.Text,
                    indexRead.Type,
                    rhsBound.Type);
                return new BoundErrorExpression(null);
            }

            assignment = BindIndexedAssignmentToVariableWithBoundValue(tempVar, indexSyntax, combined, diagnosticLocation);
        }
        else if (boundValueOverride != null)
        {
            assignment = BindIndexedAssignmentToVariableWithBoundValue(tempVar, indexSyntax, boundValueOverride, diagnosticLocation);
        }
        else
        {
            assignment = BindIndexedAssignmentToVariable(tempVar, indexSyntax, valueSyntax, diagnosticLocation);
        }

        if (assignment is BoundErrorExpression)
        {
            return assignment;
        }

        return new BoundBlockExpression(outerSyntax, ImmutableArray.Create<BoundStatement>(declaration), assignment);
    }

    private BoundExpression BindIndexedAssignmentToVariable(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        TextLocation diagnosticLocation)
    {
        return BindIndexedAssignmentToVariableCore(
            variable, indexSyntax, valueSyntax, boundValueOverride: null, diagnosticLocation);
    }

    private BoundExpression BindIndexedAssignmentToVariableWithBoundValue(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        BoundExpression boundValue,
        TextLocation diagnosticLocation)
    {
        return BindIndexedAssignmentToVariableCore(
            variable, indexSyntax, valueSyntax: null, boundValueOverride: boundValue, diagnosticLocation);
    }

    private BoundExpression BindIndexedAssignmentToVariableCore(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        BoundExpression boundValueOverride,
        TextLocation diagnosticLocation)
    {
        BoundExpression BindValue(TypeSymbol elementType)
        {
            if (boundValueOverride != null)
            {
                return conversions.BindConversion(diagnosticLocation, boundValueOverride, elementType);
            }

            return conversions.BindConversion(valueSyntax, elementType);
        }

        var element = GetIndexElementType(variable.Type);
        if (element != null)
        {
            var index = BindArrayElementIndex(indexSyntax);
            var value = BindValue(element);
            return new BoundIndexAssignmentExpression(null, variable, index, value, element);
        }

        // ADR-0122 / issue #1014: pointer indexed write `p[i] = v` == `*(p + i) = v`.
        if (variable.Type is PointerTypeSymbol pointerType)
        {
            // ADR-0122 §3 / issue #1033: a `*void` pointer has no element type,
            // so an indexed write `p[i] = v` is rejected (GS0403); cast to a
            // typed pointer `*T` first.
            if (TypeSymbol.IsVoidPointer(variable.Type))
            {
                Diagnostics.ReportVoidPointerOperationNotAllowed(diagnosticLocation, "index");
                return new BoundErrorExpression(null);
            }

            var pointerIndex = BindExpression(indexSyntax);
            if (pointerIndex is BoundErrorExpression)
            {
                return pointerIndex;
            }

            if (!IsPointerOffsetType(pointerIndex.Type))
            {
                pointerIndex = conversions.BindConversion(indexSyntax, TypeSymbol.NInt);
            }

            var elementPointer = LowerPointerOffset(new BoundVariableExpression(null, variable), pointerType, pointerIndex, subtract: false);
            var pointerValue = BindValue(pointerType.PointeeType);
            return new BoundIndirectAssignmentExpression(null, elementPointer, pointerValue);
        }

        // Phase 3.A.4: map indexed assignment `m[k] = v` — key bound to K,
        // value bound to V.
        if (variable.Type is MapTypeSymbol mapType)
        {
            var keyExpr = conversions.BindConversion(indexSyntax, mapType.KeyType);
            var valExpr = BindValue(mapType.ValueType);
            return new BoundIndexAssignmentExpression(null, variable, keyExpr, valExpr, mapType.ValueType);
        }

        // Phase 4 exit: CLR indexer write on an imported reference type
        // (e.g. `d["k"] = 1` on Dictionary[string, int]).
        // Issue #209: honour inner-position nullable flags when present.
        if (variable.Type is NullabilityAnnotatedTypeSymbol annotWr && variable.Type.ClrType is System.Type clrAnnotWr)
        {
            var idxArgsAnnotWr = ImmutableArray.Create(BindExpression(indexSyntax));
            if (this.memberLookup.TryResolveClrIndexer(clrAnnotWr, idxArgsAnnotWr, out var idxPropAnnotWr))
            {
                if (!idxPropAnnotWr.CanWrite)
                {
                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, variable.Type);
                    return new BoundErrorExpression(null);
                }

                var valueTypeAnnotWr = annotWr.GetTypeArgumentSymbolForClrType(idxPropAnnotWr.PropertyType);
                var boundValueAnnotWr = BindValue(valueTypeAnnotWr);
                return new BoundClrIndexAssignmentExpression(null, variable, idxPropAnnotWr, idxArgsAnnotWr, boundValueAnnotWr, valueTypeAnnotWr);
            }
        }
        else if (variable.Type is ImportedTypeSymbol && variable.Type.ClrType is System.Type clrTarget)
        {
            var idxArgs = ImmutableArray.Create(BindExpression(indexSyntax));
            if (this.memberLookup.TryResolveClrIndexer(clrTarget, idxArgs, out var idxProp))
            {
                // ADR-0056 §2: span element write. `Span[T]` has no `set_Item`; its
                // indexer is a `ref T`-returning getter and writes go through that
                // managed pointer. Detect the ref-returning getter and store through
                // it. A `ReadOnlySpan[T]` getter is `ref readonly T` — writing is a
                // hard error (GS0226).
                if (!idxProp.CanWrite)
                {
                    var refGetter = idxProp.GetGetMethod(nonPublic: false);
                    if (refGetter != null && refGetter.ReturnType.IsByRef)
                    {
                        if (IsReadOnlyRefReturn(idxProp, refGetter))
                        {
                            Diagnostics.ReportCannotAssignReadOnlySpanElement(diagnosticLocation, variable.Type);
                            return new BoundErrorExpression(null);
                        }

                        var pointeeType = TypeSymbol.FromClrType(refGetter.ReturnType.GetElementType()!);
                        var refValue = BindValue(pointeeType);
                        return new BoundClrIndexAssignmentExpression(null, variable, idxProp, idxArgs, refValue, pointeeType);
                    }

                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, variable.Type);
                    return new BoundErrorExpression(null);
                }

                // Issue #968: recover the symbolic element type the same way
                // the READ path does (MapErasedIndexerElementType). On a
                // `List[T]` whose element `T` is the enclosing type's generic
                // parameter, `idxProp.PropertyType` is the type-erased CLR
                // `object` (T -> object). Typing the write value as `object`
                // here would reject the assignment `_items[i] = value` (where
                // `value: T`) with GS0155 ("Cannot convert type 'T' to
                // 'object'"). Substituting the open `set_Item` value parameter
                // back through the receiver's symbolic type arguments yields the
                // real element type (`T`), so the `T` value binds without a
                // spurious boxing conversion — the WRITE-path counterpart to the
                // READ-path element-type recovery (issues #313 / #671 / #957).
                var valueType = MapErasedIndexerElementType((ImportedTypeSymbol)variable.Type, idxProp);
                var boundValue = BindValue(valueType);
                return new BoundClrIndexAssignmentExpression(null, variable, idxProp, idxArgs, boundValue, valueType);
            }
        }

        // ADR-0118 / issue #944: index assignment on a user-defined type that
        // declares an indexer member. Binds `obj[i] = v` to a call of the
        // indexer setter (`obj.set_Item(i, v)`).
        if (variable.Type is StructSymbol userIndexTarget
            && TryGetUserIndexer(userIndexTarget, out var writeIndexer, out var writeSubstitution)
            && writeIndexer.Parameters.Length == 1)
        {
            if (writeIndexer.SetterSymbol == null)
            {
                Diagnostics.ReportTypeNotIndexable(diagnosticLocation, variable.Type);
                return new BoundErrorExpression(null);
            }

            var paramType = writeSubstitution != null
                ? Binder.SubstituteType(writeIndexer.Parameters[0].Type, writeSubstitution)
                : writeIndexer.Parameters[0].Type;
            var elementType = writeSubstitution != null
                ? Binder.SubstituteType(writeIndexer.Type, writeSubstitution)
                : writeIndexer.Type;

            var indexArg = conversions.BindConversion(indexSyntax, paramType);
            var value = BindValue(elementType);
            return new BoundUserInstanceCallExpression(
                null,
                new BoundVariableExpression(null, variable),
                writeIndexer.SetterSymbol,
                ImmutableArray.Create(indexArg, value));
        }

        if (variable.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportTypeNotIndexable(diagnosticLocation, variable.Type);
        }

        return new BoundErrorExpression(null);
    }

    private static TypeSymbol MapErasedIndexerElementType(ImportedTypeSymbol target, PropertyInfo closedIndexer)
    {
        // Issue #313 (HasTypeParameterArgument): substitute the open indexer's
        // generic-parameter result back through the target's symbolic type
        // arguments so `list[i]` on `List[T]` is typed as `T`.
        // Issue #671: also substitute when the target is a constructed
        // generic with G# user-defined or nested-symbolic type arguments
        // (e.g. `outer[0]` on `List[List[MyGs]]` -> `List[MyGs]`); without
        // this the element would type-erase to `List<object>` and downstream
        // member access on the result would emit against the wrong parent.
        var hasSubstitutableArgs = !target.TypeArguments.IsDefaultOrEmpty
            && (target.HasTypeParameterArgument
                || target.TypeArguments.Any(static a => a.ClrType == null
                    || (a is ImportedTypeSymbol nested
                        && nested.OpenDefinition != null
                        && !nested.TypeArguments.IsDefaultOrEmpty)));
        if (hasSubstitutableArgs
            && target.OpenDefinition is System.Type openDefinition)
        {
            try
            {
                var openIndexer = ClrTypeUtilities.SafeGetProperty(
                    openDefinition,
                    closedIndexer.Name,
                    BindingFlags.Public | BindingFlags.Instance);
                if (openIndexer?.PropertyType is System.Type openElement)
                {
                    // ADR-0056 §1/§2: a ref-returning indexer (e.g. `Span[T]`)
                    // surfaces its element as `T&`; map it through a
                    // `ByRefTypeSymbol` so §1 auto-dereference applies.
                    var openCore = openElement.IsByRef ? openElement.GetElementType()! : openElement;
                    if (openCore.IsGenericParameter)
                    {
                        var position = openCore.GenericParameterPosition;
                        if (position >= 0 && position < target.TypeArguments.Length)
                        {
                            var arg = target.TypeArguments[position];
                            return openElement.IsByRef ? ByRefTypeSymbol.Get(arg) : arg;
                        }
                    }
                }
            }
            catch (System.Reflection.AmbiguousMatchException)
            {
                // Fall back to the erased element type below.
            }
        }

        // ADR-0056 §2: a closed ref-returning indexer (e.g. `ReadOnlySpan[int32]`
        // / `Span[int32]`) reports its element as `int32&`. Surface it as a
        // `ByRefTypeSymbol` over the pointee so the read auto-dereferences (§1)
        // and the emitter loads through the managed pointer.
        var propertyType = closedIndexer.PropertyType;
        if (propertyType.IsByRef)
        {
            return ByRefTypeSymbol.Get(TypeSymbol.FromClrType(propertyType.GetElementType()!));
        }

        return TypeSymbol.FromClrType(propertyType);
    }

    // Issue #1301: resolve the element type of a closed indexer against the
    // receiver's symbolic type arguments, mirroring the normal `this[int]`
    // index path. Routing the from-end (`a[^n]`) / `System.Index` indexer
    // paths through here keeps a user-defined element type `T` (whose
    // `ClrType` is null during binding) typed as `T` instead of erasing to
    // `object`.
    private static TypeSymbol ResolveIndexerElementType(TypeSymbol targetType, PropertyInfo indexer)
    {
        if (targetType is NullabilityAnnotatedTypeSymbol annot && annot.ClrType is System.Type)
        {
            return annot.GetTypeArgumentSymbolForClrType(indexer.PropertyType);
        }

        if (targetType is ImportedTypeSymbol imported)
        {
            return MapErasedIndexerElementType(imported, indexer);
        }

        var propertyType = indexer.PropertyType;
        if (propertyType.IsByRef)
        {
            return ByRefTypeSymbol.Get(TypeSymbol.FromClrType(propertyType.GetElementType()!));
        }

        return TypeSymbol.FromClrType(propertyType);
    }

    // ADR-0118 / issue #944: locate a user-declared indexer member on a (possibly
    // constructed-generic) user type and, for a constructed type, build the
    // type-parameter substitution from the receiver's type arguments. The
    // returned PropertySymbol is the OPEN indexer on the type definition so its
    // get_Item/set_Item accessors resolve to the emitted MethodDef handles.
    private static bool TryGetUserIndexer(
        StructSymbol target,
        out PropertySymbol indexer,
        out Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        indexer = null;
        substitution = null;

        var definition = target.Definition ?? target;
        for (var c = definition; c != null; c = c.BaseClass)
        {
            foreach (var p in c.Properties)
            {
                if (p.IsIndexer)
                {
                    indexer = p;
                    break;
                }
            }

            if (indexer != null)
            {
                break;
            }
        }

        if (indexer == null)
        {
            return false;
        }

        // Build the type-parameter substitution for a constructed generic
        // receiver (e.g. `Repo[int32]` over `class Repo[T]`).
        if (!target.TypeArguments.IsDefaultOrEmpty
            && target.Definition != null
            && !ReferenceEquals(target.Definition, target))
        {
            var defTps = target.Definition.TypeParameters;
            if (!defTps.IsDefaultOrEmpty && defTps.Length == target.TypeArguments.Length)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>(defTps.Length);
                for (var i = 0; i < defTps.Length; i++)
                {
                    substitution[defTps[i]] = target.TypeArguments[i];
                }
            }
        }

        return true;
    }

    // Issue #1016: bind a range/slice expression `target[lo..hi]` (and the
    // open-ended forms). The bound representation reuses existing nodes wrapped
    // in a BoundBlockExpression so emit and the interpreter both work without a
    // new bound-node kind. Sliceable shapes mirror C#:
    //   - arrays / slices (`[N]T`, `[]T`, CLR `T[]`) -> new T[len] + Array.Copy.
    //   - `string` -> Substring(start, len).
    //   - span-like types with `int Length`/`int Count` + `Slice(int, int)`.
    //   - types with a `this[System.Range]` indexer -> call it directly.
    // Issue #1022: bind a single from-end index `target[^n]` to the element at
    // `length - n`. The bound representation reuses existing nodes wrapped in a
    // BoundBlockExpression (no new bound-node kind). Indexable shapes mirror C#:
    //   - arrays / slices (`[N]T`, `[]T`, CLR `T[]`) -> `src[len(src) - n]`.
    //   - types with a `this[System.Index]` indexer -> call it with `^n`.
    //   - types with `int Length`/`int Count` + a `this[int]` indexer (string,
    //     List<T>, span-like) -> `src[Length - n]`.
    private BoundExpression BindFromEndIndex(BoundExpression target, FromEndIndexExpressionSyntax fromEnd, TextLocation targetLocation)
    {
        if (target is BoundErrorExpression || target.Type == TypeSymbol.Error || target.Type == null)
        {
            _ = BindExpression(fromEnd.Operand);
            return new BoundErrorExpression(null);
        }

        var element = GetIndexElementType(target.Type);
        if (element != null)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            var srcLocal = DeclareRangeTemp("src", target.Type, target, statements);
            var idx = MakeFromEndOffset(fromEnd, new BoundLenExpression(null, new BoundVariableExpression(null, srcLocal)));
            var read = new BoundIndexExpression(null, new BoundVariableExpression(null, srcLocal), idx, element);
            return new BoundBlockExpression(fromEnd, statements.ToImmutable(), read);
        }

        var clrType = target.Type.ClrType;
        if (clrType != null)
        {
            if (TryFindIndexIndexer(clrType, out var indexIndexer))
            {
                var indexCtor = typeof(System.Index).GetConstructor(new[] { typeof(int), typeof(bool) });
                var indexSym = TypeSymbol.FromClrType(typeof(System.Index));
                var offset = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
                var indexValue = new BoundClrConstructorCallExpression(
                    null,
                    typeof(System.Index),
                    indexCtor,
                    ImmutableArray.Create<BoundExpression>(offset, new BoundLiteralExpression(null, true)),
                    indexSym);
                var resultType = ResolveIndexerElementType(target.Type, indexIndexer);
                return new BoundClrIndexExpression(fromEnd, target, indexIndexer, ImmutableArray.Create<BoundExpression>(indexValue), resultType);
            }

            if (TryFindCountedIntIndexer(clrType, out var lengthMember, out var intIndexer))
            {
                var statements = ImmutableArray.CreateBuilder<BoundStatement>();
                var srcLocal = DeclareRangeTemp("src", target.Type, target, statements);
                var lengthExpr = new BoundClrPropertyAccessExpression(null, new BoundVariableExpression(null, srcLocal), lengthMember, TypeSymbol.Int32);
                var idx = MakeFromEndOffset(fromEnd, lengthExpr);
                var resultType = ResolveIndexerElementType(target.Type, intIndexer);
                var read = new BoundClrIndexExpression(
                    null,
                    new BoundVariableExpression(null, srcLocal),
                    intIndexer,
                    ImmutableArray.Create<BoundExpression>(idx),
                    resultType);
                return new BoundBlockExpression(fromEnd, statements.ToImmutable(), read);
            }
        }

        Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
        return new BoundErrorExpression(null);
    }
}
