// <copyright file="ClrOverloadResolution.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding.OverloadResolution;

/// <summary>
/// Shared C#-style "better function member" overload resolution used by the
/// binder for CLR constructor calls, static method calls on imported classes,
/// and instance method calls on imported CLR receivers. The resolver is a pure
/// function: it consumes a candidate list of <see cref="MethodBase"/> values
/// and the CLR types of the bound arguments, and returns a single best match,
/// an ambiguity, or "no applicable candidate".
/// </summary>
internal static partial class ClrOverloadResolution
{
    private static readonly Dictionary<string, string[]> NumericWideningTargets = new(StringComparer.Ordinal)
    {
        ["System.SByte"] = new[] { "System.Int16", "System.Int32", "System.Int64", "System.Single", "System.Double", "System.Decimal" },
        ["System.Byte"] = new[] { "System.Int16", "System.UInt16", "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.Single", "System.Double", "System.Decimal" },
        ["System.Int16"] = new[] { "System.Int32", "System.Int64", "System.Single", "System.Double", "System.Decimal" },
        ["System.UInt16"] = new[] { "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.Single", "System.Double", "System.Decimal" },
        ["System.Int32"] = new[] { "System.Int64", "System.Single", "System.Double", "System.Decimal" },
        ["System.UInt32"] = new[] { "System.Int64", "System.UInt64", "System.Single", "System.Double", "System.Decimal" },
        ["System.Int64"] = new[] { "System.Single", "System.Double", "System.Decimal" },
        ["System.UInt64"] = new[] { "System.Single", "System.Double", "System.Decimal" },
        ["System.Char"] = new[] { "System.UInt16", "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.Single", "System.Double", "System.Decimal" },
        ["System.Single"] = new[] { "System.Double" },
    };

    private static readonly Dictionary<string, HashSet<string>> SignedBeatsUnsigned = new(StringComparer.Ordinal)
    {
        ["System.SByte"] = new(StringComparer.Ordinal) { "System.Byte", "System.UInt16", "System.UInt32", "System.UInt64" },
        ["System.Int16"] = new(StringComparer.Ordinal) { "System.UInt16", "System.UInt32", "System.UInt64" },
        ["System.Int32"] = new(StringComparer.Ordinal) { "System.UInt32", "System.UInt64" },
        ["System.Int64"] = new(StringComparer.Ordinal) { "System.UInt64" },
    };

    public static Func<Type, Type, bool> UserDefinedImplicitConversionLookup { get; set; }

#pragma warning disable SA1201 // Elements should appear in the correct order
    public static readonly Type InlineOutVarArgumentType = typeof(InlineOutVarArgumentMarker);
#pragma warning restore SA1201

    [ThreadStatic]
#pragma warning disable SA1401 // Field should be private
#pragma warning disable SA1201 // Elements should appear in the correct order
    internal static Func<Type, Type, bool> SupplementaryInterfaceCheck;
#pragma warning restore SA1201
#pragma warning restore SA1401

    [ThreadStatic]
#pragma warning disable SA1401 // Field should be private
#pragma warning disable SA1201 // Elements should appear in the correct order
    internal static Func<int, Type, bool> ConstantNarrowingArgumentCheck;
#pragma warning restore SA1201
#pragma warning restore SA1401

    public static ImplicitConversionKind ClassifyImplicit(Type target, Type source)
    {
        if (target is null)
        {
            return ImplicitConversionKind.None;
        }

        if (ReferenceEquals(source, InlineOutVarArgumentType))
        {
            return target.IsByRef ? ImplicitConversionKind.Identity : ImplicitConversionKind.None;
        }

        if (source is null)
        {
            var t = target.IsByRef ? target.GetElementType()! : target;

            if (NullableLifting.IsValueTypeNullableClr(t))
            {
                return ImplicitConversionKind.NullableWrap;
            }

            if (!t.IsValueType)
            {
                return ImplicitConversionKind.Reference;
            }

            return ImplicitConversionKind.None;
        }

        if (target.IsByRef)
        {
            target = target.GetElementType()!;
        }

        if (source.IsByRef)
        {
            source = source.GetElementType()!;
        }

        if (ClrTypeUtilities.AreSame(target, source))
        {
            return ImplicitConversionKind.Identity;
        }

        if (IsNumericWidening(source, target))
        {
            return ImplicitConversionKind.NumericWidening;
        }

        if (string.Equals(target.FullName, "System.Object", StringComparison.Ordinal))
        {
            return source.IsValueType ? ImplicitConversionKind.Boxing : ImplicitConversionKind.Reference;
        }

        if (IsNullableWrap(source, target))
        {
            return ImplicitConversionKind.NullableWrap;
        }

        if ((string.Equals(target.FullName, "System.Delegate", StringComparison.Ordinal)
                || string.Equals(target.FullName, "System.MulticastDelegate", StringComparison.Ordinal))
            && ClrTypeUtilities.IsDelegateType(source))
        {
            return ImplicitConversionKind.Reference;
        }

        if (IsDelegateReturnCovariant(target, source))
        {
            return ImplicitConversionKind.DelegateReturnCovariance;
        }

        if (IsDelegateReturnNumericWidening(target, source))
        {
            return ImplicitConversionKind.DelegateReturnNumericWidening;
        }

        if (ReferenceEquals(target.Assembly, source.Assembly) || target.GetType() == source.GetType())
        {
            try
            {
                if (target.IsAssignableFrom(source))
                {
                    if (source.IsArray && target.IsInterface && target.IsGenericType
                        && !ClrTypeUtilities.ImplementsInterfaceByName(source, target))
                    {
                    }
                    else
                    {
                        return ImplicitConversionKind.Reference;
                    }
                }
            }
            catch (InvalidOperationException)
            {
            }
        }

        if (target.IsInterface && ClrTypeUtilities.ImplementsInterfaceByName(source, target))
        {
            return ImplicitConversionKind.Reference;
        }

        if (!source.IsValueType && !target.IsValueType && !target.IsInterface)
        {
            for (var baseType = source.BaseType; baseType != null; baseType = baseType.BaseType)
            {
                if (ClrTypeUtilities.AreSame(baseType, target))
                {
                    return ImplicitConversionKind.Reference;
                }
            }
        }

        var sic = SupplementaryInterfaceCheck;
        if (sic != null && target.IsInterface && sic(source, target))
        {
            return ImplicitConversionKind.Reference;
        }

        var udi = UserDefinedImplicitConversionLookup;
        if (udi != null && udi(source, target))
        {
            return ImplicitConversionKind.UserDefinedImplicit;
        }

        if (string.Equals(source.FullName, "System.String", StringComparison.Ordinal)
            && InterpolatedStringHandlerInfo.IsHandlerType(target))
        {
            return ImplicitConversionKind.InterpolatedStringHandler;
        }

        if (IsValueReturningDelegateToVoidDelegate(target, source))
        {
            return ImplicitConversionKind.LambdaToVoidDelegate;
        }

        if (IsStructurallyCompatibleDelegate(target, source))
        {
            return ImplicitConversionKind.DelegateStructuralMatch;
        }

        return ImplicitConversionKind.None;
    }

    public static bool IsFormattableStringTarget(Type parameterType)
    {
        if (parameterType is null)
        {
            return false;
        }

        if (parameterType.IsByRef)
        {
            parameterType = parameterType.GetElementType();
        }

        var fullName = parameterType?.FullName;
        return string.Equals(fullName, "System.FormattableString", StringComparison.Ordinal)
            || string.Equals(fullName, "System.IFormattable", StringComparison.Ordinal);
    }

    public static Result<T> Resolve<T>(IEnumerable<T> candidates, IReadOnlyList<Type> argTypes, IReadOnlyList<Type> explicitTypeArgs = null, Func<Type, Type> projectTypeArgument = null, IReadOnlyList<bool> interpolatedStringArgs = null, IReadOnlyList<string> argumentNames = null, Func<MethodInfo, ImmutableArray<TypeSymbol>> recoverTypeArgSymbols = null)
        where T : MethodBase
    {
        var applicable = new List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)>();

        var candidateList = candidates as IReadOnlyCollection<T> ?? candidates.ToList();

        foreach (var rawCandidate in candidateList)
        {
            try
            {
                EvaluateCandidate(rawCandidate, argTypes, explicitTypeArgs, projectTypeArgument, applicable, interpolatedStringArgs, argumentNames, recoverTypeArgSymbols);
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                continue;
            }
        }

        if (applicable.Count == 0)
        {
            foreach (var rawCandidate in candidateList)
            {
                try
                {
                    EvaluateExpandedParamsCandidate(rawCandidate, argTypes, explicitTypeArgs, projectTypeArgument, applicable, argumentNames, recoverTypeArgSymbols);
                }
                catch (Exception ex) when (IsMetadataLoadFailure(ex))
                {
                    continue;
                }
            }
        }

        if (applicable.Count == 0)
        {
            return Result<T>.NoneApplicable();
        }

        if (applicable.Count == 1)
        {
            var only = applicable[0];
            return Result<T>.Single(only.Method, BuildMappingArray(only.Mapping, argumentNames), only.IsExpanded);
        }

        return RankApplicable(applicable, argTypes, argumentNames);
    }

    public static bool IsParamsArrayParameter(ParameterInfo parameter)
    {
        if (parameter == null)
        {
            return false;
        }

        var paramType = parameter.ParameterType;
        if (paramType == null || !paramType.IsArray || paramType.GetArrayRank() != 1)
        {
            return false;
        }

        IList<CustomAttributeData> attrs;
        try
        {
            attrs = parameter.GetCustomAttributesData();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return false;
        }

        if (attrs == null)
        {
            return false;
        }

        for (var i = 0; i < attrs.Count; i++)
        {
            var name = attrs[i]?.AttributeType?.FullName;
            if (string.Equals(name, "System.ParamArrayAttribute", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    public static int GetParamsParameterIndex(MethodBase method)
    {
        if (method == null)
        {
            return -1;
        }

        ParameterInfo[] parameters;
        try
        {
            parameters = method.GetParameters();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return -1;
        }

        if (parameters.Length == 0)
        {
            return -1;
        }

        var lastIndex = parameters.Length - 1;
        return IsParamsArrayParameter(parameters[lastIndex]) ? lastIndex : -1;
    }

    public static bool TryGetGenericMethodParameterReturnPosition(MethodInfo closed, out int position)
    {
        position = -1;
        if (closed == null || !closed.IsGenericMethod)
        {
            return false;
        }

        var open = closed.IsGenericMethodDefinition ? closed : closed.GetGenericMethodDefinition();
        var ret = open.ReturnType;
        if (ret != null && ret.IsGenericParameter && ret.DeclaringMethod != null)
        {
            position = ret.GenericParameterPosition;
            return true;
        }

        return false;
    }

    public static int CompareNumericTargets(Type t1, Type t2, Type source)
    {
        if (t1 is null || t2 is null || source is null)
        {
            return 0;
        }

        if (ClrTypeUtilities.AreSame(t1, t2))
        {
            return 0;
        }

        var t1ToT2 = ClassifyImplicit(t2, t1) != ImplicitConversionKind.None;
        var t2ToT1 = ClassifyImplicit(t1, t2) != ImplicitConversionKind.None;

        if (t1ToT2 && !t2ToT1)
        {
            return -1;
        }

        if (t2ToT1 && !t1ToT2)
        {
            return 1;
        }

        if (t1.FullName is { } t1Name && t2.FullName is { } t2Name)
        {
            if (SignedBeatsUnsigned.TryGetValue(t1Name, out var t1Beats) && t1Beats.Contains(t2Name))
            {
                return -1;
            }

            if (SignedBeatsUnsigned.TryGetValue(t2Name, out var t2Beats) && t2Beats.Contains(t1Name))
            {
                return 1;
            }
        }

        return 0;
    }

    public static string FormatMethodSignature(MethodBase method)
    {
        if (method is null)
        {
            return "<null>";
        }

        var sb = new System.Text.StringBuilder();
        sb.Append(method.Name);

        if (method is MethodInfo mi && mi.IsGenericMethod)
        {
            sb.Append('[');
            var typeArgs = mi.GetGenericArguments();
            for (var i = 0; i < typeArgs.Length; i++)
            {
                if (i > 0)
                {
                    sb.Append(", ");
                }

                sb.Append(FormatTypeName(typeArgs[i]));
            }

            sb.Append(']');
        }

        sb.Append('(');
        var parameters = method.GetParameters();
        for (var i = 0; i < parameters.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            sb.Append(FormatTypeName(parameters[i].ParameterType));
        }

        sb.Append(')');
        return sb.ToString();
    }

    public static bool TryInferTypeArguments(MethodInfo openMethod, IReadOnlyList<Type> argTypes, out Type[] typeArgs)
    {
        typeArgs = null;
        if (openMethod is null || !openMethod.IsGenericMethodDefinition)
        {
            return false;
        }

        var parameters = openMethod.GetParameters();

        if (parameters.Length < argTypes.Count)
        {
            return false;
        }

        for (var i = argTypes.Count; i < parameters.Length; i++)
        {
            if (!parameters[i].IsOptional)
            {
                return false;
            }
        }

        var typeParams = openMethod.GetGenericArguments();
        var bounds = new Dictionary<string, Type>(StringComparer.Ordinal);
        for (var i = 0; i < argTypes.Count; i++)
        {
            var arg = argTypes[i];
            if (arg is null)
            {
                continue;
            }

            if (!UnifyForInference(parameters[i].ParameterType, arg, bounds))
            {
                return false;
            }
        }

        var result = new Type[typeParams.Length];
        for (var i = 0; i < typeParams.Length; i++)
        {
            if (!bounds.TryGetValue(typeParams[i].Name, out var bound))
            {
                return false;
            }

            result[i] = bound;
        }

        typeArgs = result;
        return true;
    }

    public static bool TryInferDeferredLambdaParameterTypes(
        MethodInfo method,
        IReadOnlyList<Type> argTypes,
        IReadOnlyList<int> lambdaParameterIndices,
        IReadOnlyList<int> expectedArities,
        out Dictionary<int, Type[]> closedLambdaParameterTypes)
    {
        closedLambdaParameterTypes = null;
        if (method is null || argTypes is null || lambdaParameterIndices is null || expectedArities is null)
        {
            return false;
        }

        MethodInfo openMethod;
        ParameterInfo[] parameters;
        try
        {
            openMethod = method.IsGenericMethodDefinition
                ? method
                : (method.IsGenericMethod ? method.GetGenericMethodDefinition() : method);
            if (!openMethod.IsGenericMethodDefinition)
            {
                return false;
            }

            parameters = openMethod.GetParameters();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return false;
        }

        if (parameters.Length < argTypes.Count)
        {
            return false;
        }

        var bounds = new Dictionary<string, Type>(StringComparer.Ordinal);
        for (var i = 0; i < argTypes.Count; i++)
        {
            var arg = argTypes[i];
            if (arg is null)
            {
                continue;
            }

            try
            {
                if (!UnifyForInference(parameters[i].ParameterType, arg, bounds))
                {
                    return false;
                }
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                return false;
            }
        }

        var result = new Dictionary<int, Type[]>();
        for (var k = 0; k < lambdaParameterIndices.Count; k++)
        {
            var paramIndex = lambdaParameterIndices[k];
            if (paramIndex < 0 || paramIndex >= parameters.Length)
            {
                return false;
            }

            MethodInfo invoke;
            ParameterInfo[] invokeParams;
            try
            {
                var delegateType = parameters[paramIndex].ParameterType;
                if (delegateType is null)
                {
                    return false;
                }

                invoke = delegateType.GetMethod("Invoke");
                if (invoke is null)
                {
                    return false;
                }

                invokeParams = invoke.GetParameters();
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                return false;
            }

            if (invokeParams.Length != expectedArities[k])
            {
                return false;
            }

            var closedParams = new Type[invokeParams.Length];
            for (var p = 0; p < invokeParams.Length; p++)
            {
                if (!TryCloseInferredType(invokeParams[p].ParameterType, bounds, out closedParams[p]))
                {
                    return false;
                }
            }

            result[paramIndex] = closedParams;
        }

        closedLambdaParameterTypes = result;
        return true;
    }

    private static bool TryCloseInferredType(Type type, IReadOnlyDictionary<string, Type> bounds, out Type closed)
    {
        closed = null;
        if (type is null)
        {
            return false;
        }

        try
        {
            if (type.IsGenericParameter)
            {
                if (!bounds.TryGetValue(type.Name, out var bound)
                    || bound is null
                    || bound.IsGenericParameter
                    || bound.ContainsGenericParameters)
                {
                    return false;
                }

                closed = bound;
                return true;
            }

            if (!type.ContainsGenericParameters)
            {
                closed = type;
                return true;
            }

            if (type.IsByRef)
            {
                return TryCloseInferredType(type.GetElementType(), bounds, out closed);
            }

            if (type.IsArray)
            {
                if (!TryCloseInferredType(type.GetElementType(), bounds, out var elem))
                {
                    return false;
                }

                closed = elem.MakeArrayType();
                return true;
            }

            if (type.IsGenericType)
            {
                var def = type.GetGenericTypeDefinition();
                var args = type.GetGenericArguments();
                var closedArgs = new Type[args.Length];
                for (var i = 0; i < args.Length; i++)
                {
                    if (!TryCloseInferredType(args[i], bounds, out closedArgs[i]))
                    {
                        return false;
                    }
                }

                closed = def.MakeGenericType(closedArgs);
                return true;
            }
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex) || ex is ArgumentException || ex is InvalidOperationException)
        {
            return false;
        }

        return false;
    }

    private static bool IsMetadataLoadFailure(Exception ex) =>
        ClrTypeUtilities.IsMetadataLoadFailure(ex);

    private static bool IsValueReturningDelegateToVoidDelegate(Type target, Type source)
    {
        if (!ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source))
        {
            return false;
        }

        MethodInfo targetInvoke;
        MethodInfo sourceInvoke;
        try
        {
            targetInvoke = target.GetMethod("Invoke");
            sourceInvoke = source.GetMethod("Invoke");
        }
        catch (Exception)
        {
            return false;
        }

        if (targetInvoke is null || sourceInvoke is null)
        {
            return false;
        }

        if (!string.Equals(targetInvoke.ReturnType.FullName, "System.Void", StringComparison.Ordinal))
        {
            return false;
        }

        if (string.Equals(sourceInvoke.ReturnType.FullName, "System.Void", StringComparison.Ordinal))
        {
            return false;
        }

        var targetParams = targetInvoke.GetParameters();
        var sourceParams = sourceInvoke.GetParameters();
        if (targetParams.Length != sourceParams.Length)
        {
            return false;
        }

        for (var i = 0; i < targetParams.Length; i++)
        {
            if (!ClrTypeUtilities.AreSame(targetParams[i].ParameterType, sourceParams[i].ParameterType))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsDelegateReturnCovariant(Type target, Type source)
    {
        if (!ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source))
        {
            return false;
        }

        if (!TryGetDelegateSignature(target, out var targetParams, out var targetReturn)
            || !TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn))
        {
            return false;
        }

        if (targetReturn is null || sourceReturn is null)
        {
            return false;
        }

        if (ClrTypeUtilities.AreSame(targetReturn, sourceReturn))
        {
            return false;
        }

        if (targetReturn.IsValueType || sourceReturn.IsValueType
            || string.Equals(targetReturn.FullName, "System.Void", StringComparison.Ordinal)
            || string.Equals(sourceReturn.FullName, "System.Void", StringComparison.Ordinal))
        {
            return false;
        }

        if (!IsReferencePreservingUpcast(targetReturn, sourceReturn))
        {
            return false;
        }

        if (targetParams.Length != sourceParams.Length)
        {
            return false;
        }

        for (var i = 0; i < targetParams.Length; i++)
        {
            if (!ClrTypeUtilities.AreSame(targetParams[i], sourceParams[i]))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsDelegateReturnNumericWidening(Type target, Type source)
    {
        if (!ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source))
        {
            return false;
        }

        if (!TryGetDelegateSignature(target, out var targetParams, out var targetReturn)
            || !TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn))
        {
            return false;
        }

        if (targetReturn is null || sourceReturn is null)
        {
            return false;
        }

        if (ClrTypeUtilities.AreSame(targetReturn, sourceReturn))
        {
            return false;
        }

        if (!IsNumericWidening(sourceReturn, targetReturn))
        {
            return false;
        }

        if (targetParams.Length != sourceParams.Length)
        {
            return false;
        }

        for (var i = 0; i < targetParams.Length; i++)
        {
            if (!ClrTypeUtilities.AreSame(targetParams[i], sourceParams[i]))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsStructurallyCompatibleDelegate(Type target, Type source)
    {
        if (!ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source))
        {
            return false;
        }

        if (ClrTypeUtilities.AreSame(target, source))
        {
            return false;
        }

        if (!TryGetDelegateSignature(target, out var targetParams, out var targetReturn)
            || !TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn))
        {
            return false;
        }

        if (targetReturn is null || sourceReturn is null
            || !ClrTypeUtilities.AreSame(targetReturn, sourceReturn))
        {
            return false;
        }

        if (targetParams.Length != sourceParams.Length)
        {
            return false;
        }

        for (var i = 0; i < targetParams.Length; i++)
        {
            if (!ClrTypeUtilities.AreSame(targetParams[i], sourceParams[i]))
            {
                return false;
            }
        }

        return true;
    }

    private static bool TryGetDelegateSignature(Type delegateType, out Type[] parameterTypes, out Type returnType)
    {
        parameterTypes = Array.Empty<Type>();
        returnType = null;

        try
        {
            var invoke = delegateType.GetMethod("Invoke");
            if (invoke != null)
            {
                var ps = invoke.GetParameters();
                var result = new Type[ps.Length];
                for (var i = 0; i < ps.Length; i++)
                {
                    result[i] = ps[i].ParameterType;
                }

                parameterTypes = result;
                returnType = invoke.ReturnType;
                return true;
            }
        }
        catch (Exception)
        {
        }

        var fullName = delegateType.FullName;
        if (fullName == null || !delegateType.IsGenericType)
        {
            return false;
        }

        Type[] genericArgs;
        try
        {
            genericArgs = delegateType.GetGenericArguments();
        }
        catch (Exception)
        {
            return false;
        }

        if (fullName.StartsWith("System.Func`", StringComparison.Ordinal) && genericArgs.Length >= 1)
        {
            var ps = new Type[genericArgs.Length - 1];
            Array.Copy(genericArgs, ps, ps.Length);
            parameterTypes = ps;
            returnType = genericArgs[genericArgs.Length - 1];
            return true;
        }

        if (fullName.StartsWith("System.Action`", StringComparison.Ordinal))
        {
            parameterTypes = genericArgs;
            returnType = typeof(void);
            return true;
        }

        try
        {
            var definition = delegateType.GetGenericTypeDefinition();
            var defInvoke = definition.GetMethod("Invoke");
            if (defInvoke == null)
            {
                return false;
            }

            var defParams = defInvoke.GetParameters();
            var resolvedParams = new Type[defParams.Length];
            for (var i = 0; i < defParams.Length; i++)
            {
                resolvedParams[i] = SubstituteGenericParameter(defParams[i].ParameterType, genericArgs);
            }

            parameterTypes = resolvedParams;
            returnType = SubstituteGenericParameter(defInvoke.ReturnType, genericArgs);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static Type SubstituteGenericParameter(Type type, Type[] genericArgs)
    {
        if (type != null && type.IsGenericParameter
            && type.GenericParameterPosition >= 0
            && type.GenericParameterPosition < genericArgs.Length)
        {
            return genericArgs[type.GenericParameterPosition];
        }

        return type;
    }

    private static bool IsReferencePreservingUpcast(Type target, Type source)
    {
        if (ClrTypeUtilities.AreSame(target, source))
        {
            return true;
        }

        if (string.Equals(target.FullName, "System.Object", StringComparison.Ordinal))
        {
            return true;
        }

        if (target.IsInterface && ClrTypeUtilities.ImplementsInterfaceByName(source, target))
        {
            return true;
        }

        for (var baseType = SafeBaseType(source); baseType != null; baseType = SafeBaseType(baseType))
        {
            if (ClrTypeUtilities.AreSame(baseType, target))
            {
                return true;
            }
        }

        return false;
    }

    private static Type SafeBaseType(Type type)
    {
        try
        {
            return type.BaseType;
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return null;
        }
    }

    private static void EvaluateCandidate<T>(T rawCandidate, IReadOnlyList<Type> argTypes, IReadOnlyList<Type> explicitTypeArgs, Func<Type, Type> projectTypeArgument, List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> applicable, IReadOnlyList<bool> interpolatedStringArgs = null, IReadOnlyList<string> argumentNames = null, Func<MethodInfo, ImmutableArray<TypeSymbol>> recoverTypeArgSymbols = null)
        where T : MethodBase
    {
        {
            T candidate = rawCandidate;

            Func<Type, Type> paramTypeRewrite = null;
            if (explicitTypeArgs != null)
            {
                if (rawCandidate is MethodInfo gmi
                    && gmi.IsGenericMethodDefinition
                    && gmi.GetGenericArguments().Length == explicitTypeArgs.Count)
                {
                    MethodInfo closed;
                    var explicitTypeArgsArray = explicitTypeArgs.ToArray();
                    try
                    {
                        closed = gmi.MakeGenericMethod(explicitTypeArgsArray);
                    }
                    catch (ArgumentException)
                    {
                        if (!TryCloseOverUserValueTypePlaceholders(gmi, explicitTypeArgsArray, recoverTypeArgSymbols?.Invoke(gmi) ?? default, out closed))
                        {
                            return;
                        }

                        paramTypeRewrite = static t => SubstituteClrType(t, typeof(UserValueTypeConstraintPlaceholder), typeof(object));
                    }

                    if (!SatisfiesGenericConstraints(gmi, explicitTypeArgsArray, recoverTypeArgSymbols?.Invoke(closed) ?? default))
                    {
                        return;
                    }

                    candidate = (T)(MethodBase)closed;
                }
                else
                {
                    return;
                }
            }
            else if (rawCandidate is MethodInfo mi && mi.IsGenericMethodDefinition)
            {
                IReadOnlyList<Type> inferenceArgTypes = argTypes;
                if (argumentNames != null && HasAnyNamedArgument(argumentNames))
                {
                    if (!TryBuildOrderedArgTypesForInference(mi, argTypes, argumentNames, out var orderedArgTypes))
                    {
                        return;
                    }

                    inferenceArgTypes = orderedArgTypes;
                }

                if (!TryInferTypeArguments(mi, inferenceArgTypes, out var typeArgs))
                {
                    return;
                }

                if (projectTypeArgument != null)
                {
                    for (var t = 0; t < typeArgs.Length; t++)
                    {
                        typeArgs[t] = projectTypeArgument(typeArgs[t]) ?? typeArgs[t];
                    }
                }

                MethodInfo closed;
                try
                {
                    closed = mi.MakeGenericMethod(typeArgs);
                }
                catch (ArgumentException)
                {
                    if (!TryCloseOverUserValueTypePlaceholders(mi, typeArgs, recoverTypeArgSymbols?.Invoke(mi) ?? default, out closed))
                    {
                        return;
                    }

                    paramTypeRewrite = static t => SubstituteClrType(t, typeof(UserValueTypeConstraintPlaceholder), typeof(object));
                }

                if (!SatisfiesGenericConstraints(mi, typeArgs, recoverTypeArgSymbols?.Invoke(closed) ?? default))
                {
                    return;
                }

                candidate = (T)(MethodBase)closed;
            }

            var parameters = candidate.GetParameters();

            int[] mapping = null;
            if (argumentNames != null && HasAnyNamedArgument(argumentNames))
            {
                if (!TryBuildNamedArgumentMapping(parameters, argTypes.Count, argumentNames, out mapping))
                {
                    return;
                }
            }
            else if (argTypes.Count > parameters.Length || !TrailingParametersOptional(parameters, argTypes.Count))
            {
                return;
            }

            var conversions = new ImplicitConversionKind[argTypes.Count];
            var paramTypes = new Type[argTypes.Count];
            var ok = true;
            for (var i = 0; i < argTypes.Count; i++)
            {
                var paramIndex = mapping != null ? mapping[i] : i;
                paramTypes[i] = paramTypeRewrite != null
                    ? paramTypeRewrite(parameters[paramIndex].ParameterType)
                    : parameters[paramIndex].ParameterType;
                var conv = ClassifyImplicit(paramTypes[i], argTypes[i]);
                if (conv == ImplicitConversionKind.None)
                {
                    if (interpolatedStringArgs != null
                        && i < interpolatedStringArgs.Count
                        && interpolatedStringArgs[i]
                        && IsFormattableStringTarget(paramTypes[i]))
                    {
                        conv = ImplicitConversionKind.InterpolatedStringToFormattable;
                    }
                    else if (ConstantNarrowingArgumentCheck != null
                        && ConstantNarrowingArgumentCheck(i, paramTypes[i]))
                    {
                        conv = ImplicitConversionKind.ConstantNarrowing;
                    }
                    else
                    {
                        ok = false;
                        break;
                    }
                }

                conversions[i] = conv;
            }

            if (ok)
            {
                applicable.Add((candidate, conversions, paramTypes, mapping, false));
            }
        }
    }

    private static void EvaluateExpandedParamsCandidate<T>(T rawCandidate, IReadOnlyList<Type> argTypes, IReadOnlyList<Type> explicitTypeArgs, Func<Type, Type> projectTypeArgument, List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> applicable, IReadOnlyList<string> argumentNames = null, Func<MethodInfo, ImmutableArray<TypeSymbol>> recoverTypeArgSymbols = null)
        where T : MethodBase
    {
        T candidate = rawCandidate;

        if (explicitTypeArgs != null)
        {
            if (rawCandidate is MethodInfo gmi
                && gmi.IsGenericMethodDefinition
                && gmi.GetGenericArguments().Length == explicitTypeArgs.Count)
            {
                MethodInfo closed;
                try
                {
                    closed = gmi.MakeGenericMethod(explicitTypeArgs.ToArray());
                }
                catch (ArgumentException)
                {
                    return;
                }

                if (!SatisfiesGenericConstraints(gmi, explicitTypeArgs.ToArray(), recoverTypeArgSymbols?.Invoke(closed) ?? default))
                {
                    return;
                }

                candidate = (T)(MethodBase)closed;
            }
            else
            {
                return;
            }
        }
        else if (rawCandidate is MethodInfo mi && mi.IsGenericMethodDefinition)
        {
            if (!TryInferTypeArgumentsForExpandedParams(mi, argTypes, argumentNames, out var typeArgs))
            {
                return;
            }

            if (projectTypeArgument != null)
            {
                for (var t = 0; t < typeArgs.Length; t++)
                {
                    typeArgs[t] = projectTypeArgument(typeArgs[t]) ?? typeArgs[t];
                }
            }

            MethodInfo closed;
            try
            {
                closed = mi.MakeGenericMethod(typeArgs);
            }
            catch (ArgumentException)
            {
                return;
            }

            if (!SatisfiesGenericConstraints(mi, typeArgs, recoverTypeArgSymbols?.Invoke(closed) ?? default))
            {
                return;
            }

            candidate = (T)(MethodBase)closed;
        }

        var parameters = candidate.GetParameters();
        if (parameters.Length == 0)
        {
            return;
        }

        var paramsIndex = parameters.Length - 1;
        if (!IsParamsArrayParameter(parameters[paramsIndex]))
        {
            return;
        }

        var elementType = parameters[paramsIndex].ParameterType.GetElementType();
        if (elementType == null)
        {
            return;
        }

        var positionalCount = argTypes.Count;
        var hasNamed = argumentNames != null && HasAnyNamedArgument(argumentNames);
        if (hasNamed)
        {
            positionalCount = 0;
            while (positionalCount < argTypes.Count && argumentNames[positionalCount] == null)
            {
                positionalCount++;
            }

            for (var i = positionalCount; i < argTypes.Count; i++)
            {
                if (argumentNames[i] == null)
                {
                    return;
                }
            }
        }

        var fixedFilledByPositional = positionalCount < paramsIndex ? positionalCount : paramsIndex;
        var tailCount = positionalCount > paramsIndex ? positionalCount - paramsIndex : 0;

        var mapping = new int[argTypes.Count];
        var filled = new bool[parameters.Length];
        for (var i = 0; i < fixedFilledByPositional; i++)
        {
            mapping[i] = i;
            filled[i] = true;
        }

        for (var i = fixedFilledByPositional; i < positionalCount; i++)
        {
            mapping[i] = paramsIndex;
        }

        if (tailCount > 0)
        {
            filled[paramsIndex] = true;
        }

        if (hasNamed)
        {
            for (var i = positionalCount; i < argTypes.Count; i++)
            {
                var name = argumentNames[i];
                var paramIdx = FindParameterIndex(parameters, name);
                if (paramIdx < 0 || paramIdx == paramsIndex || filled[paramIdx])
                {
                    return;
                }

                mapping[i] = paramIdx;
                filled[paramIdx] = true;
            }
        }

        for (var i = 0; i < paramsIndex; i++)
        {
            if (!filled[i] && !parameters[i].IsOptional)
            {
                return;
            }
        }

        var conversions = new ImplicitConversionKind[argTypes.Count];
        var paramTypes = new Type[argTypes.Count];
        for (var i = 0; i < argTypes.Count; i++)
        {
            var slot = mapping[i];
            Type target;
            if (slot == paramsIndex && i >= fixedFilledByPositional)
            {
                target = elementType;
            }
            else
            {
                target = parameters[slot].ParameterType;
            }

            paramTypes[i] = target;
            var conv = ClassifyImplicit(target, argTypes[i]);
            if (conv == ImplicitConversionKind.None)
            {
                return;
            }

            conversions[i] = conv;
        }

        var storedMapping = hasNamed ? mapping : null;
        applicable.Add((candidate, conversions, paramTypes, storedMapping, true));
    }

    private static bool TryInferTypeArgumentsForExpandedParams(MethodInfo openMethod, IReadOnlyList<Type> argTypes, IReadOnlyList<string> argumentNames, out Type[] typeArgs)
    {
        typeArgs = null;
        var parameters = openMethod.GetParameters();
        if (parameters.Length == 0)
        {
            return false;
        }

        var paramsIndex = parameters.Length - 1;
        if (!IsParamsArrayParameter(parameters[paramsIndex]))
        {
            return false;
        }

        var elementType = parameters[paramsIndex].ParameterType.GetElementType();
        if (elementType == null)
        {
            return false;
        }

        var positionalCount = argTypes.Count;
        var hasNamed = argumentNames != null && HasAnyNamedArgument(argumentNames);
        if (hasNamed)
        {
            positionalCount = 0;
            while (positionalCount < argTypes.Count && argumentNames[positionalCount] == null)
            {
                positionalCount++;
            }
        }

        var typeParams = openMethod.GetGenericArguments();
        var bounds = new Dictionary<string, Type>(StringComparer.Ordinal);

        var fixedFilledByPositional = positionalCount < paramsIndex ? positionalCount : paramsIndex;

        for (var i = 0; i < fixedFilledByPositional; i++)
        {
            if (argTypes[i] == null)
            {
                continue;
            }

            if (!UnifyForInference(parameters[i].ParameterType, argTypes[i], bounds))
            {
                return false;
            }
        }

        for (var i = fixedFilledByPositional; i < positionalCount; i++)
        {
            if (argTypes[i] == null)
            {
                continue;
            }

            if (!UnifyForInference(elementType, argTypes[i], bounds))
            {
                return false;
            }
        }

        if (hasNamed)
        {
            for (var i = positionalCount; i < argTypes.Count; i++)
            {
                var name = argumentNames[i];
                var paramIdx = FindParameterIndex(parameters, name);
                if (paramIdx < 0 || paramIdx == paramsIndex)
                {
                    return false;
                }

                if (argTypes[i] == null)
                {
                    continue;
                }

                if (!UnifyForInference(parameters[paramIdx].ParameterType, argTypes[i], bounds))
                {
                    return false;
                }
            }
        }

        var result = new Type[typeParams.Length];
        for (var i = 0; i < typeParams.Length; i++)
        {
            if (!bounds.TryGetValue(typeParams[i].Name, out var bound))
            {
                return false;
            }

            result[i] = bound;
        }

        typeArgs = result;
        return true;
    }

    private static bool HasAnyNamedArgument(IReadOnlyList<string> argumentNames)
    {
        if (argumentNames == null)
        {
            return false;
        }

        for (var i = 0; i < argumentNames.Count; i++)
        {
            if (argumentNames[i] != null)
            {
                return true;
            }
        }

        return false;
    }

    private static bool TryBuildNamedArgumentMapping(ParameterInfo[] parameters, int argCount, IReadOnlyList<string> argumentNames, out int[] mapping)
    {
        mapping = null;
        if (argCount > parameters.Length)
        {
            return false;
        }

        var result = new int[argCount];
        var filled = new bool[parameters.Length];

        var positionalCount = 0;
        for (var i = 0; i < argCount; i++)
        {
            if (argumentNames[i] != null)
            {
                break;
            }

            result[i] = i;
            filled[i] = true;
            positionalCount++;
        }

        for (var i = positionalCount; i < argCount; i++)
        {
            var name = argumentNames[i];
            if (name == null)
            {
                return false;
            }

            var paramIndex = FindParameterIndex(parameters, name);
            if (paramIndex < 0 || filled[paramIndex])
            {
                return false;
            }

            result[i] = paramIndex;
            filled[paramIndex] = true;
        }

        for (var i = 0; i < parameters.Length; i++)
        {
            if (!filled[i] && !parameters[i].IsOptional)
            {
                return false;
            }
        }

        mapping = result;
        return true;
    }

    private static int FindParameterIndex(ParameterInfo[] parameters, string name)
    {
        for (var i = 0; i < parameters.Length; i++)
        {
            if (string.Equals(parameters[i].Name, name, StringComparison.Ordinal))
            {
                return i;
            }
        }

        return -1;
    }

    private static bool TryBuildOrderedArgTypesForInference(MethodInfo openMethod, IReadOnlyList<Type> argTypes, IReadOnlyList<string> argumentNames, out Type[] orderedArgTypes)
    {
        orderedArgTypes = null;
        var parameters = openMethod.GetParameters();
        if (!TryBuildNamedArgumentMapping(parameters, argTypes.Count, argumentNames, out var mapping))
        {
            return false;
        }

        var perParam = new Type[parameters.Length];
        var filled = new bool[parameters.Length];
        for (var i = 0; i < argTypes.Count; i++)
        {
            perParam[mapping[i]] = argTypes[i];
            filled[mapping[i]] = true;
        }

        var leadingCount = 0;
        for (var i = 0; i < parameters.Length; i++)
        {
            if (filled[i])
            {
                leadingCount = i + 1;
            }
        }

        var ordered = new Type[leadingCount];
        for (var i = 0; i < leadingCount; i++)
        {
            ordered[i] = filled[i] ? perParam[i] : parameters[i].ParameterType;
        }

        orderedArgTypes = ordered;
        return true;
    }

    private static ImmutableArray<int> BuildMappingArray(int[] mapping, IReadOnlyList<string> argumentNames)
    {
        if (mapping == null || !HasAnyNamedArgument(argumentNames))
        {
            return default;
        }

        return ImmutableArray.Create(mapping);
    }

    private static bool TrailingParametersOptional(ParameterInfo[] parameters, int suppliedCount)
    {
        for (var i = suppliedCount; i < parameters.Length; i++)
        {
            if (!parameters[i].IsOptional)
            {
                return false;
            }
        }

        return true;
    }

    private static Result<T> RankApplicable<T>(List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> applicable, IReadOnlyList<Type> argTypes, IReadOnlyList<string> argumentNames)
        where T : MethodBase
    {
        var nonDominated = new List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)>();
        foreach (var c in applicable)
        {
            var dominated = false;
            foreach (var other in applicable)
            {
                if (ReferenceEquals(c.Method, other.Method))
                {
                    continue;
                }

                if (IsAtLeastAsGoodAs(other.Conversions, other.ParamTypes, c.Conversions, c.ParamTypes, argTypes))
                {
                    dominated = true;
                    break;
                }
            }

            if (!dominated)
            {
                nonDominated.Add(c);
            }
        }

        if (nonDominated.Count == 1)
        {
            return Result<T>.Single(nonDominated[0].Method, BuildMappingArray(nonDominated[0].Mapping, argumentNames), nonDominated[0].IsExpanded);
        }

        var pool = nonDominated.Count > 0 ? nonDominated : applicable;

        if (pool.Count > 1)
        {
            var minParamCount = pool.Min(w => w.Method.GetParameters().Length);
            var fewestParams = pool
                .Where(w => w.Method.GetParameters().Length == minParamCount)
                .ToList();
            if (fewestParams.Count >= 1 && fewestParams.Count < pool.Count)
            {
                pool = fewestParams;
            }

            if (pool.Count == 1)
            {
                return Result<T>.Single(pool[0].Method, BuildMappingArray(pool[0].Mapping, argumentNames), pool[0].IsExpanded);
            }
        }

        if (pool.Count > 1)
        {
            var mostSpecific = pool
                .Where(w => pool.All(o => ReferenceEquals(w.Method, o.Method) || IsAtLeastAsSpecific(w.Method, o.Method)))
                .ToList();
            if (mostSpecific.Count >= 1 && mostSpecific.Count < pool.Count)
            {
                pool = mostSpecific;
            }

            if (pool.Count == 1)
            {
                return Result<T>.Single(pool[0].Method, BuildMappingArray(pool[0].Mapping, argumentNames), pool[0].IsExpanded);
            }
        }

        if (pool.Count > 1)
        {
            var nonGeneric = pool.Where(w => !IsGenericMethod(w.Method)).ToList();
            if (nonGeneric.Count >= 1 && nonGeneric.Count < pool.Count)
            {
                pool = nonGeneric;
            }

            if (pool.Count == 1)
            {
                return Result<T>.Single(pool[0].Method, BuildMappingArray(pool[0].Mapping, argumentNames), pool[0].IsExpanded);
            }
        }

        if (pool.Count > 1)
        {
            var mostDerived = FilterToMostDerivedDeclaringType(pool);
            if (mostDerived.Count >= 1 && mostDerived.Count < pool.Count)
            {
                pool = mostDerived;
            }

            if (pool.Count == 1)
            {
                return Result<T>.Single(pool[0].Method, BuildMappingArray(pool[0].Mapping, argumentNames), pool[0].IsExpanded);
            }
        }

        if (pool.Count > 1)
        {
            var mostConstrained = pool
                .Where(w => pool.All(o => ReferenceEquals(w.Method, o.Method) || CompareConstraintSpecificity(w.Method, o.Method) >= 0))
                .ToList();
            if (mostConstrained.Count >= 1 && mostConstrained.Count < pool.Count)
            {
                pool = mostConstrained;
            }

            if (pool.Count == 1)
            {
                return Result<T>.Single(pool[0].Method, BuildMappingArray(pool[0].Mapping, argumentNames), pool[0].IsExpanded);
            }
        }

        var ambiguous = pool
            .Select(c => c.Method)
            .ToImmutableArray();
        return Result<T>.AmbiguousResult(ambiguous);
    }

    private static bool IsGenericMethod(MethodBase method)
        => method is MethodInfo mi && mi.IsGenericMethod;

    private static List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> FilterToMostDerivedDeclaringType<T>(
        List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)> pool)
    {
        var result = new List<(T Method, ImplicitConversionKind[] Conversions, Type[] ParamTypes, int[] Mapping, bool IsExpanded)>(pool.Count);
        foreach (var candidate in pool)
        {
            var declaringType = (candidate.Method as MethodBase)?.DeclaringType;
            if (declaringType == null)
            {
                result.Add(candidate);
                continue;
            }

            bool isHidden = false;
            foreach (var other in pool)
            {
                if (ReferenceEquals(candidate.Method as MethodBase, other.Method as MethodBase))
                {
                    continue;
                }

                var otherDeclaring = (other.Method as MethodBase)?.DeclaringType;
                if (otherDeclaring != null && otherDeclaring != declaringType && IsSubclassOf(otherDeclaring, declaringType))
                {
                    isHidden = true;
                    break;
                }
            }

            if (!isHidden)
            {
                result.Add(candidate);
            }
        }

        return result;
    }

    private static bool IsSubclassOf(Type derived, Type baseType)
    {
        if (derived == null || baseType == null)
        {
            return false;
        }

        var baseFullName = baseType.FullName;
        for (var current = derived.BaseType; current != null; current = current.BaseType)
        {
            if (current == baseType || current.FullName == baseFullName)
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsAtLeastAsGoodAs(
        ImplicitConversionKind[] a,
        Type[] paramsA,
        ImplicitConversionKind[] b,
        Type[] paramsB,
        IReadOnlyList<Type> sources)
    {
        var hasStrictlyBetter = false;
        for (var i = 0; i < a.Length; i++)
        {
            var cmp = CompareConversions(a[i], paramsA[i], b[i], paramsB[i], sources[i]);
            if (cmp > 0)
            {
                return false;
            }

            if (cmp < 0)
            {
                hasStrictlyBetter = true;
            }
        }

        return hasStrictlyBetter;
    }

    private static int CompareConversions(
        ImplicitConversionKind ka,
        Type paramA,
        ImplicitConversionKind kb,
        Type paramB,
        Type source)
    {
        if (ka == ImplicitConversionKind.InterpolatedStringToFormattable
            && kb == ImplicitConversionKind.Reference
            && IsSystemObject(paramB))
        {
            return -1;
        }

        if (kb == ImplicitConversionKind.InterpolatedStringToFormattable
            && ka == ImplicitConversionKind.Reference
            && IsSystemObject(paramA))
        {
            return 1;
        }

        if (ka != kb)
        {
            return ((int)ka).CompareTo((int)kb);
        }

        if (ka == ImplicitConversionKind.NumericWidening)
        {
            return CompareNumericTargets(paramA, paramB, source);
        }

        if (ka == ImplicitConversionKind.ConstantNarrowing)
        {
            return CompareNumericTargets(paramA, paramB, source);
        }

        if (ka == ImplicitConversionKind.DelegateReturnNumericWidening)
        {
            if (TryGetDelegateSignature(paramA, out _, out var retA)
                && TryGetDelegateSignature(paramB, out _, out var retB)
                && TryGetDelegateSignature(source, out _, out var retSource)
                && retA != null && retB != null && retSource != null)
            {
                return CompareNumericTargets(retA, retB, retSource);
            }

            return 0;
        }

        if (ka == ImplicitConversionKind.InterpolatedStringToFormattable)
        {
            var aIsFs = string.Equals(PeelByRef(paramA)?.FullName, "System.FormattableString", StringComparison.Ordinal);
            var bIsFs = string.Equals(PeelByRef(paramB)?.FullName, "System.FormattableString", StringComparison.Ordinal);
            if (aIsFs && !bIsFs)
            {
                return -1;
            }

            if (bIsFs && !aIsFs)
            {
                return 1;
            }
        }

        return 0;
    }

    private static bool IsSystemObject(Type type)
    {
        type = PeelByRef(type);
        return type != null && string.Equals(type.FullName, "System.Object", StringComparison.Ordinal);
    }

    private static Type PeelByRef(Type type)
    {
        return type is { IsByRef: true } ? type.GetElementType() : type;
    }

    private static bool IsAtLeastAsSpecific(MethodBase a, MethodBase b)
    {
        var pa = a.GetParameters();
        var pb = b.GetParameters();

        var shared = Math.Min(pa.Length, pb.Length);
        for (var i = 0; i < shared; i++)
        {
            if (!ClrTypeUtilities.IsAssignableByName(pb[i].ParameterType, pa[i].ParameterType))
            {
                return false;
            }
        }

        return true;
    }

    private static bool SatisfiesGenericConstraints(MethodInfo openMethod, Type[] typeArgs, ImmutableArray<TypeSymbol> typeArgSymbols = default)
    {
        if (openMethod is null || typeArgs is null)
        {
            return true;
        }

        Type[] typeParams;
        try
        {
            typeParams = openMethod.GetGenericArguments();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return true;
        }

        if (typeParams.Length != typeArgs.Length)
        {
            return true;
        }

        for (var i = 0; i < typeParams.Length; i++)
        {
            var param = typeParams[i];
            var arg = typeArgs[i];
            if (arg is null || arg.IsGenericParameter)
            {
                continue;
            }

            GenericParameterAttributes attrs;
            try
            {
                attrs = param.GenericParameterAttributes;
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                continue;
            }

            var special = attrs & GenericParameterAttributes.SpecialConstraintMask;

            var argIsUserValueType = !typeArgSymbols.IsDefaultOrEmpty
                && i < typeArgSymbols.Length
                && IsUserValueTypeSymbol(typeArgSymbols[i]);

            if ((special & GenericParameterAttributes.ReferenceTypeConstraint) != 0)
            {
                if (arg.IsValueType || argIsUserValueType)
                {
                    return false;
                }
            }

            if ((special & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0)
            {
                if (!argIsUserValueType
                    && (!arg.IsValueType || NullableLifting.IsValueTypeNullableClr(arg)))
                {
                    return false;
                }
            }

            if ((special & GenericParameterAttributes.DefaultConstructorConstraint) != 0
                && (special & GenericParameterAttributes.NotNullableValueTypeConstraint) == 0)
            {
                if (!arg.IsValueType && !argIsUserValueType)
                {
                    try
                    {
                        var ctor = arg.GetConstructor(Type.EmptyTypes);
                        if (ctor is null || !ctor.IsPublic)
                        {
                            return false;
                        }
                    }
                    catch (Exception ex) when (IsMetadataLoadFailure(ex))
                    {
                    }
                }
            }

            Type[] typeConstraints;
            try
            {
                typeConstraints = param.GetGenericParameterConstraints();
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                continue;
            }

            for (var c = 0; c < typeConstraints.Length; c++)
            {
                var constraint = typeConstraints[c];
                if (constraint is null || constraint.IsGenericParameter || constraint.ContainsGenericParameters)
                {
                    continue;
                }

                if (argIsUserValueType
                    && (string.Equals(constraint.FullName, "System.ValueType", StringComparison.Ordinal)
                        || string.Equals(constraint.FullName, "System.Enum", StringComparison.Ordinal)))
                {
                    continue;
                }

                try
                {
                    if (!ClrTypeUtilities.IsAssignableByName(constraint, arg))
                    {
                        return false;
                    }
                }
                catch (Exception ex) when (IsMetadataLoadFailure(ex))
                {
                }
            }
        }

        return true;
    }

    private static bool IsUserValueTypeSymbol(TypeSymbol symbol)
        => symbol is StructSymbol { IsClass: false } or EnumSymbol;

    private static bool TryCloseOverUserValueTypePlaceholders(
        MethodInfo openDef,
        Type[] typeArgs,
        ImmutableArray<TypeSymbol> recoveredSymbols,
        out MethodInfo closed)
    {
        closed = null;
        if (openDef is null || typeArgs is null || recoveredSymbols.IsDefaultOrEmpty)
        {
            return false;
        }

        var substituted = (Type[])typeArgs.Clone();
        var anyUserValueType = false;
        for (var i = 0; i < substituted.Length && i < recoveredSymbols.Length; i++)
        {
            if (substituted[i] != null
                && !substituted[i].IsValueType
                && IsUserValueTypeSymbol(recoveredSymbols[i]))
            {
                substituted[i] = typeof(UserValueTypeConstraintPlaceholder);
                anyUserValueType = true;
            }
        }

        if (!anyUserValueType || !SatisfiesGenericConstraints(openDef, typeArgs, recoveredSymbols))
        {
            return false;
        }

        try
        {
            closed = openDef.MakeGenericMethod(substituted);
        }
        catch (ArgumentException)
        {
            return false;
        }

        return true;
    }

    private static Type SubstituteClrType(Type type, Type from, Type to)
    {
        if (type is null || type == from)
        {
            return type == from ? to : type;
        }

        if (type.IsByRef)
        {
            return SubstituteClrType(type.GetElementType(), from, to).MakeByRefType();
        }

        if (type.IsArray)
        {
            var element = SubstituteClrType(type.GetElementType(), from, to);
            var rank = type.GetArrayRank();
            return rank == 1 ? element.MakeArrayType() : element.MakeArrayType(rank);
        }

        if (type.IsGenericType && !type.IsGenericTypeDefinition)
        {
            var args = type.GetGenericArguments();
            var changed = false;
            for (var i = 0; i < args.Length; i++)
            {
                var rewritten = SubstituteClrType(args[i], from, to);
                if (!ReferenceEquals(rewritten, args[i]))
                {
                    args[i] = rewritten;
                    changed = true;
                }
            }

            return changed ? type.GetGenericTypeDefinition().MakeGenericType(args) : type;
        }

        return type;
    }

    private static int ConstraintSpecificityScore(GenericParameterAttributes attrs)
    {
        var special = attrs & GenericParameterAttributes.SpecialConstraintMask;
        if ((special & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0)
        {
            return 2;
        }

        if ((special & GenericParameterAttributes.ReferenceTypeConstraint) != 0)
        {
            return 1;
        }

        return 0;
    }

    private static int CompareConstraintSpecificity(MethodBase a, MethodBase b)
    {
        if (a is not MethodInfo ma || b is not MethodInfo mb)
        {
            return 0;
        }

        if (!ma.IsGenericMethod || !mb.IsGenericMethod)
        {
            return 0;
        }

        MethodInfo aOpen, bOpen;
        try
        {
            aOpen = ma.IsGenericMethodDefinition ? ma : ma.GetGenericMethodDefinition();
            bOpen = mb.IsGenericMethodDefinition ? mb : mb.GetGenericMethodDefinition();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return 0;
        }

        Type[] aParams, bParams;
        try
        {
            aParams = aOpen.GetGenericArguments();
            bParams = bOpen.GetGenericArguments();
        }
        catch (Exception ex) when (IsMetadataLoadFailure(ex))
        {
            return 0;
        }

        if (aParams.Length != bParams.Length)
        {
            return 0;
        }

        var aMore = false;
        var bMore = false;
        for (var i = 0; i < aParams.Length; i++)
        {
            int s1;
            int s2;
            try
            {
                s1 = ConstraintSpecificityScore(aParams[i].GenericParameterAttributes);
                s2 = ConstraintSpecificityScore(bParams[i].GenericParameterAttributes);
            }
            catch (Exception ex) when (IsMetadataLoadFailure(ex))
            {
                return 0;
            }

            if (s1 > s2)
            {
                aMore = true;
            }
            else if (s2 > s1)
            {
                bMore = true;
            }
        }

        if (aMore && !bMore)
        {
            return 1;
        }

        if (bMore && !aMore)
        {
            return -1;
        }

        return 0;
    }

    private static string FormatTypeName(Type type)
    {
        if (type is null)
        {
            return "<null>";
        }

        if (type.IsByRef)
        {
            return "ref " + FormatTypeName(type.GetElementType());
        }

        if (type.IsArray)
        {
            return FormatTypeName(type.GetElementType()) + "[]";
        }

        if (type.IsGenericParameter)
        {
            return type.Name;
        }

        if (type.IsGenericType)
        {
            var def = type.GetGenericTypeDefinition();
            var defName = def.Name;
            var tickIndex = defName.IndexOf('`');
            if (tickIndex >= 0)
            {
                defName = defName.Substring(0, tickIndex);
            }

            var args = type.GetGenericArguments();
            var sb = new System.Text.StringBuilder();
            sb.Append(defName);
            sb.Append('[');
            for (var i = 0; i < args.Length; i++)
            {
                if (i > 0)
                {
                    sb.Append(", ");
                }

                sb.Append(FormatTypeName(args[i]));
            }

            sb.Append(']');
            return sb.ToString();
        }

        return type.Name;
    }

    private static bool IsNumericWidening(Type source, Type target)
    {
        if (source.FullName is { } sn && target.FullName is { } tn
            && NumericWideningTargets.TryGetValue(sn, out var targets))
        {
            foreach (var t in targets)
            {
                if (string.Equals(t, tn, StringComparison.Ordinal))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool IsNullableWrap(Type source, Type target)
    {
        if (!NullableLifting.IsValueTypeNullableClr(target))
        {
            return false;
        }

        var underlying = target.GetGenericArguments()[0];
        return ClrTypeUtilities.AreSame(underlying, source);
    }

    private static bool UnifyForInference(Type parameterType, Type argumentType, Dictionary<string, Type> bounds)
    {
        if (parameterType is null || argumentType is null)
        {
            return true;
        }

        if (parameterType.IsGenericParameter)
        {
            if (bounds.TryGetValue(parameterType.Name, out var existing))
            {
                if (ClrTypeUtilities.AreSame(existing, argumentType))
                {
                    return true;
                }

                if (NullableLifting.IsValueTypeNullableClr(argumentType))
                {
                    var underlying = argumentType.GetGenericArguments()[0];
                    if (ClrTypeUtilities.AreSame(underlying, existing))
                    {
                        bounds[parameterType.Name] = argumentType;
                        return true;
                    }
                }

                if (NullableLifting.IsValueTypeNullableClr(existing))
                {
                    var underlying = existing.GetGenericArguments()[0];
                    if (ClrTypeUtilities.AreSame(underlying, argumentType))
                    {
                        return true;
                    }
                }

                try
                {
                    if (existing.IsAssignableFrom(argumentType))
                    {
                        return true;
                    }

                    if (argumentType.IsAssignableFrom(existing))
                    {
                        bounds[parameterType.Name] = argumentType;
                        return true;
                    }
                }
                catch (InvalidOperationException)
                {
                    return false;
                }

                return false;
            }

            bounds[parameterType.Name] = argumentType;
            return true;
        }

        if (parameterType.IsArray)
        {
            if (argumentType.IsArray)
            {
                UnifyForInference(parameterType.GetElementType(), argumentType.GetElementType(), bounds);
            }

            return true;
        }

        if (parameterType.IsByRef)
        {
            return UnifyForInference(parameterType.GetElementType(), argumentType, bounds);
        }

        if (parameterType.IsGenericType && !parameterType.IsGenericTypeDefinition)
        {
            var openDef = parameterType.GetGenericTypeDefinition();
            var paramArgs = parameterType.GetGenericArguments();

            var matched = FindClosedGeneric(argumentType, openDef);
            if (matched != null)
            {
                var matchedArgs = matched.GetGenericArguments();
                for (var i = 0; i < paramArgs.Length && i < matchedArgs.Length; i++)
                {
                    if (!UnifyForInference(paramArgs[i], matchedArgs[i], bounds))
                    {
                        return false;
                    }
                }
            }

            return true;
        }

        return true;
    }

    private static Type FindClosedGeneric(Type type, Type openDefinition)
    {
        if (openDefinition is null)
        {
            return null;
        }

        var openDefName = openDefinition.FullName;

        try
        {
            for (var t = type; t != null; t = t.BaseType)
            {
                if (t.IsGenericType && MatchesOpenDefinition(t.GetGenericTypeDefinition(), openDefinition, openDefName))
                {
                    return t;
                }
            }
        }
        catch (NotSupportedException)
        {
        }

        Type[] ifaces;
        try
        {
            ifaces = type.GetInterfaces();
        }
        catch (InvalidOperationException)
        {
            return null;
        }
        catch (NotSupportedException)
        {
            if (type.IsGenericType && !type.IsGenericTypeDefinition
                && MatchesOpenDefinition(type.GetGenericTypeDefinition(), openDefinition, openDefName))
            {
                return type;
            }

            return null;
        }

        foreach (var iface in ifaces)
        {
            if (iface.IsGenericType && MatchesOpenDefinition(iface.GetGenericTypeDefinition(), openDefinition, openDefName))
            {
                return iface;
            }
        }

        return null;
    }

    private static bool MatchesOpenDefinition(Type candidateDefinition, Type openDefinition, string openDefName)
    {
        if (ReferenceEquals(candidateDefinition, openDefinition))
        {
            return true;
        }

        return openDefName != null
            && string.Equals(candidateDefinition.FullName, openDefName, StringComparison.Ordinal);
    }
}
