// <copyright file="OverloadResolver.Invocations.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class OverloadResolver
{
    /// <summary>
    /// Issue #1213 / #1221: lowers a call through a delegate/function-typed
    /// variable to a <see cref="BoundIndirectCallExpression"/>, with two
    /// event-raise refinements when the variable is the implicit backing-field
    /// of a field-like event (an <see cref="ImplicitFieldVariableSymbol"/>):
    /// <list type="bullet">
    /// <item><description>The callee is loaded as a field read on <c>this</c>
    /// (e.g. <c>ldfld Base::Changed</c>) — including the backing field declared
    /// on a base class, so an inherited event can be raised from a derived type
    /// — rather than a (non-existent) local slot.</description></item>
    /// <item><description>The conditional raise form <c>Ev?(args)</c> on a
    /// <c>void</c> delegate is guarded by a null check (a
    /// <see cref="BoundNullConditionalAccessExpression"/>), so raising an event
    /// with no subscribers is a safe no-op, mirroring <c>Ev?.Invoke(args)</c>.
    /// </description></item>
    /// </list>
    /// </summary>
    private BoundExpression BuildIndirectDelegateCall(
        CallExpressionSyntax syntax,
        VariableSymbol variable,
        FunctionTypeSymbol fnType,
        ImmutableArray<BoundExpression> args,
        TypeSymbol narrowedTargetType = null)
    {
        if (variable is ImplicitFieldVariableSymbol implicitField)
        {
            if (syntax.NullableQuestionToken != null
                && ReferenceEquals(fnType.ReturnType, TypeSymbol.Void))
            {
                var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter)
                    .ToString(System.Globalization.CultureInfo.InvariantCulture);
                var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: implicitField.Field.Type);
                var invoke = new BoundIndirectCallExpression(null, new BoundVariableExpression(null, capture), fnType, args);
                return new BoundNullConditionalAccessExpression(
                    syntax,
                    BuildImplicitFieldLoad(implicitField),
                    capture,
                    invoke,
                    TypeSymbol.Void,
                    resultSlot: null);
            }

            return new BoundIndirectCallExpression(null, BuildImplicitFieldLoad(implicitField), fnType, args);
        }

        if (TryBuildImplicitMemberLoad(variable, syntax.Identifier.Location, out var memberLoad))
        {
            return new BoundIndirectCallExpression(null, memberLoad, fnType, args);
        }

        // Issue #2066: a smart-cast-narrowed local carries the narrowed
        // (non-nullable, possibly named-delegate) type so the emitter's
        // `call.Target.Type is DelegateTypeSymbol` check in EmitIndirectCall
        // dispatches through the named delegate's own Invoke MethodDef
        // instead of the type-erased native-function Invoke, which would
        // otherwise mismatch the value's actual runtime (named-delegate)
        // shape and fail IL verification.
        return new BoundIndirectCallExpression(null, new BoundVariableExpression(null, variable, narrowedTargetType), fnType, args);
    }

    /// <summary>
    /// Issue #1213 / #1221: loads an <see cref="ImplicitFieldVariableSymbol"/>
    /// (the implicit <c>this</c>-field exposed for a bare field/event name) as
    /// a field read on its declaring type. The declaring type carried by the
    /// symbol may be a base class, producing the correct base field token when
    /// the access originates from a derived method.
    /// </summary>
    private static BoundExpression BuildImplicitFieldLoad(ImplicitFieldVariableSymbol implicitField) =>
        new BoundFieldAccessExpression(
            null,
            new BoundVariableExpression(null, implicitField.Receiver),
            implicitField.StructType,
            implicitField.Field);

    private bool TryBindNullableDelegateInvocation(
        VariableSymbol variable,
        CallExpressionSyntax syntax,
        ImmutableArray<BoundExpression> boundArguments,
        ImmutableArray<string> argumentNames,
        out BoundExpression result)
    {
        result = null;
        if (syntax.NullableQuestionToken == null
            || variable.Type is not NullableTypeSymbol nullable
            || !MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(nullable.UnderlyingType, out var functionType))
        {
            return false;
        }

        if (!argumentNames.IsDefault)
        {
            Diagnostics.ReportNamedArgumentParameterNotFound(syntax.Identifier.Location, variable.Name, FirstNamedArgumentName(argumentNames));
            result = new BoundErrorExpression(null);
            return true;
        }

        if (!TryBindFunctionTypeArguments(variable.Name, functionType, syntax, boundArguments, out var convertedArgs))
        {
            result = new BoundErrorExpression(null);
            return true;
        }

        var delegateLoad = TryBuildImplicitMemberLoad(variable, syntax.Identifier.Location, out var implicitLoad)
            ? implicitLoad
            : new BoundVariableExpression(null, variable);
        if (delegateLoad is BoundErrorExpression)
        {
            result = delegateLoad;
            return true;
        }

        var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter)
            .ToString(System.Globalization.CultureInfo.InvariantCulture);
        var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: nullable.UnderlyingType);
        var captureRef = new BoundVariableExpression(null, capture);
        var whenNotNull = new BoundIndirectCallExpression(null, captureRef, functionType, convertedArgs);

        if (ReferenceEquals(functionType.ReturnType, TypeSymbol.Void))
        {
            result = new BoundNullConditionalAccessExpression(
                syntax,
                delegateLoad,
                capture,
                whenNotNull,
                TypeSymbol.Void,
                resultSlot: null);
            return true;
        }

        var resultType = functionType.ReturnType is NullableTypeSymbol
            ? functionType.ReturnType
            : (TypeSymbol)NullableTypeSymbol.Get(functionType.ReturnType);
        LocalVariableSymbol resultSlot = null;
        if (resultType is NullableTypeSymbol nullableResult
            && nullableResult.UnderlyingType?.ClrType is { IsValueType: true })
        {
            var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
            resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
        }

        result = new BoundNullConditionalAccessExpression(
            syntax,
            delegateLoad,
            capture,
            whenNotNull,
            resultType,
            resultSlot);
        return true;
    }

    private bool TryBindFunctionTypeArguments(
        string calleeName,
        FunctionTypeSymbol functionType,
        CallExpressionSyntax syntax,
        ImmutableArray<BoundExpression> boundArguments,
        out ImmutableArray<BoundExpression> convertedArgs)
    {
        convertedArgs = default;
        var isVariadic = functionType.HasVariadic;
        var fixedCount = isVariadic ? functionType.Arity - 1 : functionType.Arity;

        if (isVariadic)
        {
            if (syntax.Arguments.Count < fixedCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(syntax.Identifier.Location, calleeName, fixedCount, syntax.Arguments.Count);
                return false;
            }
        }
        else if (syntax.Arguments.Count != functionType.Arity)
        {
            Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, calleeName, functionType.Arity, syntax.Arguments.Count);
            return false;
        }

        var permutedArgs = boundArguments;
        if (isVariadic)
        {
            // Issue #1630: pack/pass-through through the canonical helper
            // (applies #1493 element coercion when packing).
            var sliceType = (SliceTypeSymbol)functionType.ParameterTypes[functionType.Arity - 1];
            var hasElementErrors = false;
            permutedArgs = PackOrPassThroughVariadicArguments(
                conversions,
                Diagnostics,
                syntax,
                boundArguments,
                fixedCount,
                sliceType,
                calleeName,
                i => syntax.Arguments[i].Location,
                ref hasElementErrors);

            if (hasElementErrors)
            {
                return false;
            }
        }

        var convertedBuilder = ImmutableArray.CreateBuilder<BoundExpression>(permutedArgs.Length);
        for (var i = 0; i < permutedArgs.Length; i++)
        {
            var argLoc = i < syntax.Arguments.Count ? syntax.Arguments[i].Location : syntax.Identifier.Location;
            var argument = permutedArgs[i];
            var argSyntax = i < syntax.Arguments.Count ? UnwrapNamedArgumentValue(syntax.Arguments[i]) : null;
            if (argSyntax != null
                && bindLambdaWithTarget != null
                && IsUntypedArrowLambda(argSyntax)
                && functionType.ParameterTypes[i] is FunctionTypeSymbol lambdaTarget)
            {
                argument = bindLambdaWithTarget((LambdaExpressionSyntax)argSyntax, lambdaTarget);
            }

            convertedBuilder.Add(conversions.BindConversion(argLoc, argument, functionType.ParameterTypes[i]));
        }

        convertedArgs = convertedBuilder.MoveToImmutable();
        return true;
    }

    private bool TryBuildImplicitMemberLoad(VariableSymbol variable, TextLocation location, out BoundExpression load)
    {
        load = null;
        switch (variable)
        {
            case ImplicitStaticFieldVariableSymbol staticField:
                load = staticField.InterfaceType != null
                    ? new BoundFieldAccessExpression(null, staticField.Field, staticField.InterfaceType)
                    : new BoundFieldAccessExpression(null, receiver: null, staticField.StructType, staticField.Field);
                return true;
            case ImplicitFieldVariableSymbol instanceField:
                load = new BoundFieldAccessExpression(
                    null,
                    new BoundVariableExpression(null, instanceField.Receiver),
                    instanceField.StructType,
                    instanceField.Field);
                return true;
            case ImplicitPropertyVariableSymbol prop:
                if (!prop.Property.HasGetter)
                {
                    Diagnostics.ReportCannotAssign(location, prop.Property.Name);
                    load = new BoundErrorExpression(null);
                    return true;
                }

                load = new BoundPropertyAccessExpression(
                    null,
                    new BoundVariableExpression(null, prop.Receiver),
                    prop.StructType,
                    prop.Property);
                return true;
            case ImplicitStaticPropertyVariableSymbol staticProp:
                if (!staticProp.Property.HasGetter)
                {
                    Diagnostics.ReportCannotAssign(location, staticProp.Property.Name);
                    load = new BoundErrorExpression(null);
                    return true;
                }

                load = new BoundPropertyAccessExpression(
                    null,
                    receiver: null,
                    staticProp.StructType,
                    staticProp.Property);
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// Issue #1566: determines whether every top-level function overload with the
    /// given name is an extension function. When true, an unqualified,
    /// receiver-less call to that name inside a type should first try to bind
    /// against an accessible member of the enclosing type (member-over-extension
    /// shadowing) before falling back to the extension.
    /// </summary>
    /// <param name="name">The invoked identifier.</param>
    /// <returns><see langword="true"/> when at least one overload exists and all of them are extension functions.</returns>
    private bool IsAllExtensionOverloadSet(string name)
    {
        var overloads = Scope.TryLookupFunctions(name);
        if (overloads.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var overload in overloads)
        {
            if (!overload.IsExtension)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #2066: replicates <c>ExpressionBinder.TryGetNarrowedType(VariableSymbol)</c>
    /// so direct call-syntax binding (which looks up the callee via
    /// <c>Scope.TryLookupSymbol</c> rather than a bound name-expression read)
    /// can see an active smart-cast null-guard narrowing on the callee local.
    /// Walks the active frame stack innermost-first — the topmost narrowing
    /// wins, mirroring the name-expression lookup.
    /// </summary>
    private TypeSymbol TryGetNarrowedVariableType(VariableSymbol variable)
    {
        for (var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i--)
        {
            if (binderCtx.NarrowedVariables[i].TryGetValue(variable, out var narrowed))
            {
                return narrowed;
            }
        }

        // Issue #2185: a bare field/property callee (`hn(value)` after an
        // `if hn == nil { return }` guard) records its null-guard narrowing under
        // the stable member access path (`this.hn`), not the bare variable symbol.
        // Look that path up too, so a smart-cast-narrowed nullable function-typed
        // field is recognised as callable exactly like a narrowed local. Only
        // nullable-typed implicit members can carry such a narrowing, and the
        // guard avoids invoking the diagnostic-emitting member-load path for any
        // other symbol shape.
        var isNarrowableImplicitMember = variable.Type is NullableTypeSymbol
            && (variable is ImplicitFieldVariableSymbol
                || (variable is ImplicitPropertyVariableSymbol prop && prop.Property.HasGetter));
        if (isNarrowableImplicitMember
            && TryBuildImplicitMemberLoad(variable, default, out var memberLoad)
            && memberLoad is not BoundErrorExpression
            && SmartCastStability.TryGetStablePath(memberLoad) is AccessPath memberPath
            && memberPath.HasMembers)
        {
            for (var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i--)
            {
                if (binderCtx.NarrowedVariables[i].TryGetValue(memberPath, out var narrowedMember))
                {
                    return narrowedMember;
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #2185: binds an <em>indirect</em> invocation <c>callee(args)</c> whose
    /// <see cref="CallExpressionSyntax.Callee"/> is an arbitrary expression (a parenthesized
    /// expression, a null-forgiveness <c>expr!!</c>, a curried <c>f()</c>, an indexer read, ...).
    /// The callee is bound as an ordinary expression — so smart-cast narrowing and null-forgiveness
    /// already produce its non-null (function) type — and the call is accepted whenever that bound
    /// type is a G# <see cref="FunctionTypeSymbol"/>, a user-declared <see cref="DelegateTypeSymbol"/>,
    /// or a CLR delegate. Any other callee type reports GS0131 ("is not a function").
    /// </summary>
    private BoundExpression BindIndirectCallExpression(CallExpressionSyntax syntax)
    {
        var callee = bindExpression(syntax.Callee);
        if (callee is BoundErrorExpression)
        {
            return callee;
        }

        // The verbatim source spelling of the callee (`(value)`, `handler!!`, ...)
        // used in diagnostics — SyntaxNode.ToString() pretty-prints the whole tree.
        var calleeName = syntax.Callee.SyntaxTree.Text.ToString(syntax.Callee.Span);

        // Named args have no meaning without preserved parameter names.
        if (!TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        if (!argumentNames.IsDefault)
        {
            Diagnostics.ReportNamedArgumentParameterNotFound(syntax.Callee.Location, calleeName, FirstNamedArgumentName(argumentNames));
            return new BoundErrorExpression(null);
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        var deferredArrowLambdaIndices = new HashSet<int>();
        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            var argSyntax = UnwrapNamedArgumentValue(syntax.Arguments[i]);
            if (bindLambdaWithTarget != null && IsUntypedArrowLambda(argSyntax))
            {
                // Defer: TryBindFunctionTypeArguments re-binds the lambda once the
                // callee's parameter delegate shape is known (mirrors the direct path).
                deferredArrowLambdaIndices.Add(i);
                boundArguments.Add(new BoundErrorExpression(argSyntax));
            }
            else
            {
                boundArguments.Add(BindOverloadArgumentValue(argSyntax));
            }
        }

        if (deferredArrowLambdaIndices.Count == 0)
        {
            foreach (var boundArgument in boundArguments)
            {
                if (boundArgument is BoundErrorExpression)
                {
                    return new BoundErrorExpression(null);
                }
            }
        }

        if (callee.Type is FunctionTypeSymbol fnType)
        {
            if (!TryBindFunctionTypeArguments(calleeName, fnType, syntax, boundArguments.ToImmutable(), out var convertedArgs))
            {
                return new BoundErrorExpression(null);
            }

            return new BoundIndirectCallExpression(syntax, callee, fnType, convertedArgs);
        }

        if (callee.Type is DelegateTypeSymbol delegateSym)
        {
            if (!TryBindFunctionTypeArguments(calleeName, delegateSym.EquivalentFunctionType, syntax, boundArguments.ToImmutable(), out var convertedDelegateArgs))
            {
                return new BoundErrorExpression(null);
            }

            return new BoundIndirectCallExpression(syntax, callee, delegateSym.EquivalentFunctionType, convertedDelegateArgs);
        }

        // A value whose CLR type is a delegate (e.g. `Func[int32, int32]`) is
        // callable through its `Invoke` method, mirroring the direct-call path.
        if (callee.Type?.ClrType is System.Type calleeClrType && ClrTypeUtilities.IsDelegateType(calleeClrType))
        {
            if (tryBindInheritedClrInstanceCall(callee, calleeClrType, "Invoke", boundArguments.ToImmutable(), syntax, out var invokeCall, null, default, argumentNames))
            {
                return invokeCall;
            }
        }

        Diagnostics.ReportNotAFunction(syntax.Callee.Location, calleeName);
        return new BoundErrorExpression(null);
    }

    public BoundExpression BindExtensionFunctionCall(BoundExpression receiver, FunctionSymbol extension, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, ImmutableArray<string> argumentNames = default)
    {
        // The extension's first parameter is the receiver; user arguments line
        // up against parameters[1..].
        var userParamCount = extension.Parameters.Length - 1;

        // ADR-0063 / issue #1556: count the leading non-optional user
        // parameters. A receiver-form (extension) call may omit any trailing
        // parameter that declares a default value, mirroring the free-function,
        // static (`shared`), and user-instance call paths. The receiver
        // occupies `Parameters[0]`, so the scan runs over the user slice
        // `Parameters[1..]` and the omitted trailing slots are synthesized from
        // each parameter's captured default constant below.
        var requiredUserParamCount = userParamCount;
        for (var i = userParamCount - 1; i >= 0; i--)
        {
            if (extension.Parameters[i + 1].HasExplicitDefaultValue)
            {
                requiredUserParamCount = i;
            }
            else
            {
                break;
            }
        }

        if (arguments.Length < requiredUserParamCount || arguments.Length > userParamCount)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, extension.Name, userParamCount, arguments.Length);
            return new BoundErrorExpression(null);
        }

        // Issue #343: reorder named arguments into the extension's parameter
        // order (excluding the synthetic receiver slot). ADR-0063 / issue #1556:
        // positional calls may omit trailing optional parameters; the omitted
        // slots are padded from each parameter's captured default value after
        // the reorder below.
        ExpressionSyntax[] permutedSyntax;
        ImmutableArray<BoundExpression> permutedArguments;
        if (!argumentNames.IsDefault)
        {
            if (!TryReorderUserCallArguments(
                    ce.Arguments,
                    arguments,
                    userParamCount,
                    p => extension.Parameters[p + 1].Name,
                    extension.Name,
                    out permutedSyntax,
                    out permutedArguments))
            {
                return new BoundErrorExpression(null);
            }
        }
        else
        {
            permutedSyntax = new ExpressionSyntax[ce.Arguments.Count];
            for (var i = 0; i < ce.Arguments.Count; i++)
            {
                permutedSyntax[i] = ce.Arguments[i];
            }

            permutedArguments = arguments;
        }

        // ADR-0063 / issue #1556: pad any omitted trailing optional parameters
        // with their captured default values so the generic-inference and
        // per-position conversion loops below bind the full user parameter list
        // (matching the free-function, static, and user-instance call paths).
        // Named-argument calls are reordered above against the full parameter
        // count, so this positional pad is gated on the unnamed shape.
        if (argumentNames.IsDefault && permutedArguments.Length < userParamCount)
        {
            var padded = ImmutableArray.CreateBuilder<BoundExpression>(userParamCount);
            padded.AddRange(permutedArguments);
            for (var i = permutedArguments.Length; i < userParamCount; i++)
            {
                padded.Add(CreateOptionalUserDefaultArgument(extension.Parameters[i + 1]));
            }

            permutedArguments = padded.MoveToImmutable();
        }

        // Issue #326: a generic extension function
        // `func (r R) Name[T](item T) T` resolves its type parameters either
        // from an explicit `[T1, T2]` type-argument list at the call site or by
        // left-to-right inference from the receiver and argument types matched
        // against the declared parameter types. Mirrors the free-function
        // generic path (Phase 4.1 / ADR-0020).
        Dictionary<TypeParameterSymbol, TypeSymbol> substitution = null;
        if (extension.IsGeneric)
        {
            substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            if (ce.TypeArgumentList != null)
            {
                var explicitArgs = ce.TypeArgumentList.Arguments;
                if (explicitArgs.Count != extension.TypeParameters.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(ce.TypeArgumentList.Location, extension.Name, extension.TypeParameters.Length, explicitArgs.Count);
                    return new BoundErrorExpression(null);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = bindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    substitution[extension.TypeParameters[i]] = ta;
                }
            }
            else
            {
                // The receiver lines up against parameters[0]; user arguments
                // against parameters[1..]. Inferring from the receiver too lets
                // a generic receiver type (e.g. `func (s []T) ...`) bind T.
                if (receiver?.Type != null)
                {
                    inferTypeArguments(extension.Parameters[0].Type, receiver.Type, substitution);
                }

                for (var i = 0; i < permutedArguments.Length; i++)
                {
                    if (permutedArguments[i].Type != null)
                    {
                        inferTypeArguments(extension.Parameters[i + 1].Type, permutedArguments[i].Type, substitution);
                    }
                }

                foreach (var tp in extension.TypeParameters)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(ce.Identifier.Location, extension.Name, tp.Name);
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
            var constraintLocation = ce.TypeArgumentList != null
                ? ce.TypeArgumentList.Location
                : ce.Identifier.Location;
            foreach (var tp in extension.TypeParameters)
            {
                var typeArg = substitution[tp];
                if (!satisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, describeConstraint(tp));
                    return new BoundErrorExpression(null);
                }
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(extension.Parameters.Length);
        var receiverParamType = substitution != null ? substituteType(extension.Parameters[0].Type, substitution) : extension.Parameters[0].Type;
        convertedArgs.Add(conversions.BindConversion(ce.Location, receiver, receiverParamType));
        for (var i = 0; i < permutedArguments.Length; i++)
        {
            var paramType = extension.Parameters[i + 1].Type;
            if (substitution != null && TypeSymbol.ContainsTypeParameter(paramType))
            {
                if (paramType is FunctionTypeSymbol openFunctionParameter
                    && tryGetFunctionLiteral(permutedArguments[i], out var functionLiteralArgument))
                {
                    // ADR-0087 §3 R6: substitute the open target so the
                    // identity-check inside the adapter drops the
                    // wrapper when the literal already matches.
                    var substitutedOpenTarget = (substituteType(openFunctionParameter, substitution) as FunctionTypeSymbol)
                        ?? openFunctionParameter;
                    convertedArgs.Add(createErasedFunctionLiteralAdapter(functionLiteralArgument, substitutedOpenTarget));
                    continue;
                }

                // A parameter typed as an open T is encoded as System.Object in
                // the emitted signature; pass the argument unconverted so the
                // emitter inserts box / unbox.any around the erased boundary.
                convertedArgs.Add(permutedArguments[i]);
            }
            else
            {
                var expectedType = substitution != null ? substituteType(paramType, substitution) : paramType;
                var argLoc = i < permutedSyntax.Length ? permutedSyntax[i].Location : ce.Location;
                convertedArgs.Add(conversions.BindCallArgumentWithRefKind(argLoc, permutedArguments[i], expectedType, extension.Parameters[i + 1]));
            }
        }

        // Issue #1931: stash the extension function's own (explicit or
        // inferred) type arguments on the bound node so the emitter's
        // MethodSpec construction can use this authoritative bind-time result
        // instead of re-deriving it via structural unification.
        var extensionMethodTypeArguments = default(ImmutableArray<TypeSymbol>);
        if (extension.IsGeneric && substitution != null)
        {
            var extensionMethodTypeArgsBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(extension.TypeParameters.Length);
            foreach (var tp in extension.TypeParameters)
            {
                extensionMethodTypeArgsBuilder.Add(substitution[tp]);
            }

            extensionMethodTypeArguments = extensionMethodTypeArgsBuilder.MoveToImmutable();
        }

        if (substitution != null)
        {
            var returnType = substituteType(extension.Type, substitution);
            if (extension.IsAsync && !isAsyncIteratorReturnType(extension.Type))
            {
                returnType = wrapAsTask(returnType, extension.AsyncReturnsValueTask);
            }

            return new BoundCallExpression(null, extension, convertedArgs.MoveToImmutable(), returnType) { MethodTypeArguments = extensionMethodTypeArguments };
        }

        // Issue #1376: an async receiver-clause (extension) function's call-site
        // return type is Task / Task[T], not the underlying void / T. Wrap here
        // so awaiting the call sees a value-bearing Task, mirroring the async
        // free-function and user-instance-call paths.
        if (extension.IsAsync && !isAsyncIteratorReturnType(extension.Type))
        {
            var asyncReturn = wrapAsTask(extension.Type, extension.AsyncReturnsValueTask);
            return new BoundCallExpression(null, extension, convertedArgs.MoveToImmutable(), asyncReturn) { MethodTypeArguments = extensionMethodTypeArguments };
        }

        return new BoundCallExpression(null, extension, convertedArgs.MoveToImmutable()) { MethodTypeArguments = extensionMethodTypeArguments };
    }

    public BoundExpression BindUserInstanceCall(BoundExpression receiver, FunctionSymbol method, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, ImmutableArray<string> argumentNames = default, TypeParameterSymbol constrainedReceiverTypeParameter = null)
    {
        // Issue #950 / #2044 / #2058: enforce `protected`/`private` method
        // access — a `protected` method is only callable from the declaring
        // type and its derived types, and a `private` method is only
        // callable from within its declaring top-level type's body. The
        // emitted IL also carries the matching CIL accessibility so the CLR
        // enforces the same rule independently.
        if (method.ReceiverType is StructSymbol methodDeclaringType
            && !AccessibilityChecker.IsAccessible(method.Accessibility, methodDeclaringType, getCurrentFunction()))
        {
            Diagnostics.ReportMemberInaccessible(ce.Identifier.Location, method.Name, methodDeclaringType.Name, method.Accessibility);
        }

        var parameterOffset = method.ExplicitReceiverParameter == null ? 0 : 1;
        var callableParameterCount = method.Parameters.Length - parameterOffset;

        // ADR-0101 follow-up / issue #812: class / interface instance methods
        // may declare a trailing variadic parameter. The arity check accepts
        // any count >= fixed parameters (the fixed prefix is everything
        // except the trailing variadic). Pack / pass-through happens below
        // before the per-position conversion loop.
        var isVariadic = method.Parameters.Length > 0
            && method.Parameters[method.Parameters.Length - 1].IsVariadic;
        var fixedCallableParamCount = isVariadic ? callableParameterCount - 1 : callableParameterCount;

        // ADR-0063 / issue #1319: count the leading non-optional callable
        // parameters. An instance / constructor call may omit any trailing
        // parameter that declares a default value; the omitted slots are
        // synthesized from each parameter's captured default constant below,
        // mirroring the top-level and static (`shared`) call paths. The
        // receiver parameter (when present) is excluded via `parameterOffset`.
        var requiredCallableParamCount = callableParameterCount;
        for (var i = callableParameterCount - 1; i >= 0; i--)
        {
            if (method.Parameters[i + parameterOffset].HasExplicitDefaultValue)
            {
                requiredCallableParamCount = i;
            }
            else
            {
                break;
            }
        }

        // Issue #343: variadic functions and named arguments do not compose.
        if (isVariadic && !argumentNames.IsDefault)
        {
            Diagnostics.ReportNamedArgumentParameterNotFound(ce.Identifier.Location, method.Name, FirstNamedArgumentName(argumentNames));
            return new BoundErrorExpression(null);
        }

        if (isVariadic)
        {
            if (arguments.Length < fixedCallableParamCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(ce.Identifier.Location, method.Name, fixedCallableParamCount, arguments.Length);
                return new BoundErrorExpression(null);
            }
        }
        else if (arguments.Length < requiredCallableParamCount || arguments.Length > callableParameterCount)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, method.Name, callableParameterCount, arguments.Length);
            return new BoundErrorExpression(null);
        }

        // Issue #343: reorder named arguments into the method's parameter
        // order. ADR-0063 / issue #1319: positional calls may omit trailing
        // optional parameters; the omitted slots are padded from each
        // parameter's captured default value after the reorder below.
        ExpressionSyntax[] permutedSyntax;
        ImmutableArray<BoundExpression> permutedArguments;
        if (!argumentNames.IsDefault)
        {
            if (!TryReorderUserCallArguments(
                    ce.Arguments,
                    arguments,
                    callableParameterCount,
                    p => method.Parameters[p + parameterOffset].Name,
                    method.Name,
                    out permutedSyntax,
                    out permutedArguments))
            {
                return new BoundErrorExpression(null);
            }
        }
        else
        {
            permutedSyntax = new ExpressionSyntax[ce.Arguments.Count];
            for (var i = 0; i < ce.Arguments.Count; i++)
            {
                permutedSyntax[i] = ce.Arguments[i];
            }

            permutedArguments = arguments;
        }

        // ADR-0063 / issue #1319: pad any omitted trailing optional parameters
        // with their captured default values so the per-position conversion loop
        // binds the full callable parameter list (matching the top-level and
        // static call paths). Variadic methods never reach here with a short
        // slice (their trailing slot is packed below), so the optional pad is
        // gated on the non-variadic shape.
        if (argumentNames.IsDefault && !isVariadic && permutedArguments.Length < callableParameterCount)
        {
            var padded = ImmutableArray.CreateBuilder<BoundExpression>(callableParameterCount);
            padded.AddRange(permutedArguments);
            for (var i = permutedArguments.Length; i < callableParameterCount; i++)
            {
                padded.Add(CreateOptionalUserDefaultArgument(method.Parameters[i + parameterOffset]));
            }

            permutedArguments = padded.MoveToImmutable();
        }

        // Phase 4.3b / ADR-0020: if the receiver is a constructed generic
        // class/struct, substitute the method's parameter types and return
        // type with the receiver's type-argument map. The method symbol
        // itself (and its bound body) are kept intact so runtime dispatch
        // through program.Functions[method] continues to work.
        Dictionary<TypeParameterSymbol, TypeSymbol> substitution = TryBuildReceiverSubstitution(receiver.Type);

        // Issue #312 / ADR-0020: the method may declare its own generic
        // type-parameter list (`func M[T](...) T`). Resolve those type
        // arguments from an explicit `[T1, T2]` list at the call site or by
        // left-to-right inference from argument types, then fold them into the
        // same substitution map used for the receiver's type arguments.
        if (method.IsGeneric)
        {
            if (substitution == null)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            }

            if (ce.TypeArgumentList != null)
            {
                var explicitArgs = ce.TypeArgumentList.Arguments;
                if (explicitArgs.Count != method.TypeParameters.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(ce.TypeArgumentList.Location, method.Name, method.TypeParameters.Length, explicitArgs.Count);
                    return new BoundErrorExpression(null);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = bindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    substitution[method.TypeParameters[i]] = ta;
                }
            }
            else
            {
                for (var i = 0; i < permutedArguments.Length; i++)
                {
                    // ADR-0101 follow-up / issue #812: when the call lands
                    // on the trailing variadic parameter (whose type is
                    // `[]T`), each trailing argument contributes to `T`'s
                    // inference. A single trailing `[]U` argument infers
                    // `T = U` from the slice element so the pass-through
                    // path works.
                    var paramType = method.Parameters[i + parameterOffset].Type;
                    if (isVariadic
                        && i + parameterOffset == method.Parameters.Length - 1
                        && paramType is SliceTypeSymbol variadicSlice)
                    {
                        var argType = permutedArguments[i].Type;
                        if (permutedArguments.Length - i == 1 && argType is SliceTypeSymbol passThroughSlice)
                        {
                            inferTypeArguments(variadicSlice.ElementType, passThroughSlice.ElementType, substitution);
                        }
                        else
                        {
                            for (var j = i; j < permutedArguments.Length; j++)
                            {
                                inferTypeArguments(variadicSlice.ElementType, permutedArguments[j].Type, substitution);
                            }
                        }

                        break;
                    }

                    inferTypeArguments(paramType, permutedArguments[i].Type, substitution);
                }

                foreach (var tp in method.TypeParameters)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(ce.Identifier.Location, method.Name, tp.Name);
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
            var constraintLocation = ce.TypeArgumentList != null
                ? ce.TypeArgumentList.Location
                : ce.Identifier.Location;
            foreach (var tp in method.TypeParameters)
            {
                var typeArg = substitution[tp];
                if (!satisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, describeConstraint(tp));
                    return new BoundErrorExpression(null);
                }
            }
        }

        // ADR-0101 follow-up / issue #812: pack or pass-through trailing
        // variadic arguments before per-position conversion. Mirrors the
        // top-level call path: a single trailing argument whose substituted
        // type matches the variadic slice type forwards unchanged; otherwise
        // the trailing args are typed against the element type and packed
        // into a fresh `BoundArrayCreationExpression`.
        if (isVariadic)
        {
            var variadicParam = method.Parameters[method.Parameters.Length - 1];
            var paramSliceType = (SliceTypeSymbol)variadicParam.Type;
            var sliceType = substitution != null
                ? (SliceTypeSymbol)substituteType(paramSliceType, substitution)
                : paramSliceType;
            var trailingCount = permutedArguments.Length - fixedCallableParamCount;

            var passThrough = trailingCount == 1
                && permutedArguments[fixedCallableParamCount].Type == sliceType;

            if (!passThrough)
            {
                // Issue #1630: pack through the canonical helper (applies
                // #1493 element coercion).
                var hasVariadicErrors = false;
                permutedArguments = PackOrPassThroughVariadicArguments(
                    conversions,
                    Diagnostics,
                    ce,
                    permutedArguments,
                    fixedCallableParamCount,
                    sliceType,
                    variadicParam.Name,
                    i => permutedSyntax[i]?.Location ?? ce.Location,
                    ref hasVariadicErrors);

                if (hasVariadicErrors)
                {
                    return new BoundErrorExpression(null);
                }

                var newSyntax = new ExpressionSyntax[fixedCallableParamCount + 1];
                for (var i = 0; i < fixedCallableParamCount; i++)
                {
                    newSyntax[i] = permutedSyntax[i];
                }

                // The packed-slice slot has no corresponding source argument
                // (or, when the user supplied one or more trailing args, we
                // collapse them down to a single synthetic slot). Use the
                // first trailing arg's syntax when present, otherwise leave
                // null and the conversion loop will fall back to `ce.Location`.
                newSyntax[fixedCallableParamCount] = permutedSyntax.Length > fixedCallableParamCount
                    ? permutedSyntax[fixedCallableParamCount]
                    : null;
                permutedSyntax = newSyntax;
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArguments.Length);
        for (var i = 0; i < permutedArguments.Length; i++)
        {
            var parameter = method.Parameters[i + parameterOffset];
            var paramType = parameter.Type;

            // ADR-0060 / issue #1133: an inline-decl `out var n` / `out let n` /
            // `out _` was bound with TypeSymbol.Error in the first pass (from
            // BindCallExpression, before the method was resolved) and never
            // declared a local. Now that overload resolution has chosen the
            // method — and the receiver / method type-argument substitution is
            // known — re-bind it so the synthesized local is typed from the
            // resolved (substituted) out-parameter pointee type and leaks into
            // the enclosing block scope. This mirrors the free-function path
            // and the imported-method RebindInlineOutVarArguments helper, and
            // must run BEFORE the open-type-parameter shortcut below so generic
            // out-parameters (`func M[T](out result T)`) are handled too.
            if (permutedArguments[i] is BoundAddressOfExpression inlineOutAddr
                && inlineOutAddr.Operand.Type == TypeSymbol.Error)
            {
                var slotSyntax = i < permutedSyntax.Length ? permutedSyntax[i] : null;
                var pointeeType = substitution != null ? substituteType(paramType, substitution) : paramType;
                var reboundOutVar = tryRebindInlineOutVarPlaceholder(permutedArguments[i], slotSyntax, parameter, pointeeType);
                if (reboundOutVar != null)
                {
                    convertedArgs.Add(reboundOutVar);
                    continue;
                }
            }

            // An argument bound to an open type parameter is left untouched —
            // the emitter boxes value types at the call boundary (the parameter
            // is encoded as System.Object under the type-erased model).
            if (paramType is TypeParameterSymbol)
            {
                convertedArgs.Add(permutedArguments[i]);
                continue;
            }

            var expectedType = substitution != null ? substituteType(paramType, substitution) : paramType;

            if (substitution != null
                && tryGetFunctionLiteral(permutedArguments[i], out var functionLiteralArgument))
            {
                if (paramType is FunctionTypeSymbol openFunctionParameter)
                {
                    // ADR-0087 §3 R6: substitute the open target so the
                    // identity-check inside the adapter drops the
                    // wrapper when the literal already matches.
                    var substitutedOpenTarget = (substituteType(openFunctionParameter, substitution) as FunctionTypeSymbol)
                        ?? openFunctionParameter;
                    convertedArgs.Add(createErasedFunctionLiteralAdapter(functionLiteralArgument, substitutedOpenTarget));
                    continue;
                }

                if (MemberLookup.TryGetLambdaTargetFunctionType(paramType.ClrType ?? expectedType.ClrType, out var targetDelegateFunctionType)
                    && functionLiteralArgument.FunctionType != targetDelegateFunctionType)
                {
                    convertedArgs.Add(createErasedFunctionLiteralAdapter(functionLiteralArgument, targetDelegateFunctionType));
                    continue;
                }
            }

            var argSyntaxForLocation = i < permutedSyntax.Length ? permutedSyntax[i] : null;

            // ADR-0055 Tier 4 (#369): re-lower an interpolated-string argument to
            // FormattableStringFactory.Create when the parameter is
            // IFormattable/FormattableString.
            var argSyntaxForInterp = argSyntaxForLocation != null ? UnwrapNamedArgumentValue(argSyntaxForLocation) : null;
            if (argSyntaxForInterp is InterpolatedStringExpressionSyntax interpolatedArg
        && isFormattableStringTargetType(expectedType))
            {
        convertedArgs.Add(bindInterpolatedStringAsFormattable(interpolatedArg, expectedType));
        continue;
            }

            var argLoc = argSyntaxForLocation?.Location ?? ce.Location;
            convertedArgs.Add(conversions.BindCallArgumentWithRefKind(argLoc, permutedArguments[i], expectedType, method.Parameters[i + parameterOffset]));
        }

        // Issue #1931: stash the method's own (explicit or inferred) type
        // arguments on the bound node regardless of whether they affect the
        // return type below, so the emitter's MethodSpec construction can use
        // this authoritative bind-time result instead of re-deriving it via
        // structural unification (which can fail for uninformative argument
        // shapes like a bare `nil`).
        ImmutableArray<TypeSymbol> methodTypeArguments = default;
        if (method.IsGeneric && substitution != null)
        {
            var methodTypeArgsBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(method.TypeParameters.Length);
            foreach (var tp in method.TypeParameters)
            {
                methodTypeArgsBuilder.Add(substitution[tp]);
            }

            methodTypeArguments = methodTypeArgsBuilder.MoveToImmutable();
        }

        BoundUserInstanceCallExpression MakeCall(TypeSymbol returnTypeOverride)
        {
            var result = new BoundUserInstanceCallExpression(null, receiver, method, convertedArgs.ToImmutable(), returnTypeOverride, constrainedReceiverTypeParameter, constrainedReceiverTypeParameter?.InterfaceConstraint);
            result.MethodTypeArguments = methodTypeArguments;
            return result;
        }

        if (substitution != null)
        {
            var substitutedReturn = substituteType(method.Type, substitution);
            if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
            {
                substitutedReturn = wrapAsTask(substitutedReturn, method.AsyncReturnsValueTask);
                return MakeCall(substitutedReturn);
            }

            if (!ReferenceEquals(substitutedReturn, method.Type))
            {
                return MakeCall(substitutedReturn);
            }
        }

        // Issue #502: an async instance method's call-site return type is
        // Task / Task[T], not the underlying T. Wrap here so the call
        // expression's static type matches the kickoff method's return type.
        if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
        {
            var asyncReturn = wrapAsTask(method.Type, method.AsyncReturnsValueTask);
            return MakeCall(asyncReturn);
        }

        return MakeCall(returnTypeOverride: null);
    }

    private static Dictionary<TypeParameterSymbol, TypeSymbol> TryBuildReceiverSubstitution(TypeSymbol receiverType)
    {
        if (receiverType is not StructSymbol start)
        {
            return null;
        }

        // Issue #1250: an inherited method's signature is declared in terms of
        // its declaring class's type parameters (e.g. `LinkTo(next FilterBase[TOut])`
        // on `TransformBase[TIn, TOut]`). When the method is reached through a
        // derived receiver (`AudioFilter : TransformBase[FrameEntry, FrameEntry]`),
        // the substitution must compose every hop of the base chain so the
        // inherited type parameters (TIn/TOut) resolve to the concrete arguments
        // seen at the most-derived level. Walk the chain accumulating each
        // class's declaration-parameter -> (resolved) argument mappings, exactly
        // like Conversion.DerivesFromConstructed threads its map for subtyping.
        Dictionary<TypeParameterSymbol, TypeSymbol> map = null;
        for (var c = start; c != null; c = c.BaseClass)
        {
            // Issue #1537: a receiver that is a generic type nested inside a
            // generic enclosing type (e.g. `Outer[int32].Middle[string]`)
            // carries the enclosing construction's arguments on
            // EnclosingTypeArguments (`[int32]`) separately from its own
            // arguments (`[string]`). An instance method's signature may mention
            // the ENCLOSING type's parameters (a method returning `U`), so map
            // each enclosing parameter to its construction argument in addition
            // to the own parameter -> own argument mappings below.
            if (!c.EnclosingTypeArguments.IsDefaultOrEmpty)
            {
                var enclosingParams = StructSymbol.CollectEnclosingTypeParameters(c);
                var enclosingCount = System.Math.Min(enclosingParams.Length, c.EnclosingTypeArguments.Length);
                for (var i = 0; i < enclosingCount; i++)
                {
                    var arg = c.EnclosingTypeArguments[i];
                    if (arg is TypeParameterSymbol tpEnc && map != null && map.TryGetValue(tpEnc, out var resolvedEnc))
                    {
                        arg = resolvedEnc;
                    }

                    map ??= new Dictionary<TypeParameterSymbol, TypeSymbol>();
                    map[enclosingParams[i]] = arg;
                }
            }

            if (c.Definition == null
                || ReferenceEquals(c.Definition, c)
                || c.TypeArguments.IsDefaultOrEmpty
                || c.Definition.TypeParameters.IsDefaultOrEmpty)
            {
                continue;
            }

            var defTps = c.Definition.TypeParameters;
            var count = System.Math.Min(defTps.Length, c.TypeArguments.Length);
            for (var i = 0; i < count; i++)
            {
                var arg = c.TypeArguments[i];

                // Resolve an argument that is itself one of a more-derived
                // class's type parameters through the running map.
                if (arg is TypeParameterSymbol tpArg && map != null && map.TryGetValue(tpArg, out var resolved))
                {
                    arg = resolved;
                }

                map ??= new Dictionary<TypeParameterSymbol, TypeSymbol>();
                map[defTps[i]] = arg;
            }
        }

        return map;
    }
}
