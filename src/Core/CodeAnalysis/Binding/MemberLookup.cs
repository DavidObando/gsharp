// <copyright file="MemberLookup.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// PR-B-2: the binder-facing facade for "given a type T and a member name N,
/// return the candidates". Delegates low-level CLR member walks (including
/// inherited interfaces) to <see cref="ClrTypeUtilities"/> and user-symbol
/// scope lookups to <see cref="BoundScope"/> via <see cref="BinderContext"/>.
/// </summary>
/// <remarks>
/// <para>
/// This type is deliberately <em>pure</em>: it does not emit diagnostics,
/// it does not construct <c>BoundExpression</c> values, and it does not
/// mutate <see cref="BinderContext.NarrowedVariables"/> or
/// <see cref="BinderContext.LoopStack"/>. The cache fields on
/// <see cref="BinderContext"/> for imported <c>[Extension]</c> classes
/// (<see cref="BinderContext.CachedImportedExtensionClasses"/> and
/// <see cref="BinderContext.CachedImportedExtensionImportCount"/>) are
/// intentionally written by <see cref="GetImportedExtensionClasses"/> —
/// those fields exist on the context precisely so this facade can populate
/// them.
/// </para>
/// <para>
/// All decisions about "what to do with no candidate" — diagnostic emission
/// (e.g. <c>GS0159</c>, <c>GS0125</c>, <c>GS0187</c>), error-recovery
/// <c>BoundErrorExpression</c> construction, narrowing-state updates — live
/// on the caller in <see cref="Binder"/>.
/// </para>
/// </remarks>
internal sealed class MemberLookup
{
    private readonly BinderContext binderCtx;

    /// <summary>
    /// Initializes a new instance of the <see cref="MemberLookup"/> class.
    /// </summary>
    /// <param name="binderCtx">The shared binder context that exposes the
    /// reference resolver, the root <see cref="BoundScope"/>, and the
    /// imported-extension cache fields.</param>
    public MemberLookup(BinderContext binderCtx)
    {
        this.binderCtx = binderCtx ?? throw new ArgumentNullException(nameof(binderCtx));
    }

    // ----- CLR-side type walks -----

    /// <summary>
    /// Enumerates <paramref name="t"/> followed by every interface it
    /// implements (direct and inherited). The common building block used by
    /// the dictionary/enumerable shape probes below — kept here so future
    /// fixes for #568/#572/#573 (which all need the same interface walk) can
    /// reuse one helper.
    /// </summary>
    /// <param name="t">The starting CLR type.</param>
    /// <returns>The type and its interfaces in walk order.</returns>
    public static IEnumerable<Type> EnumerateSelfAndInterfaces(Type t)
    {
        yield return t;
        foreach (var i in t.GetInterfaces())
        {
            yield return i;
        }
    }

    /// <summary>
    /// Probes <paramref name="type"/> for an
    /// <c>IAsyncEnumerable&lt;T&gt;</c> implementation and returns its
    /// element type when present.
    /// </summary>
    /// <param name="type">The <see cref="TypeSymbol"/> to probe.</param>
    /// <param name="elementType">The bound element type symbol, on success.</param>
    /// <returns><see langword="true"/> when the type implements
    /// <c>IAsyncEnumerable&lt;T&gt;</c>.</returns>
    public static bool TryGetAsyncEnumerableElementType(TypeSymbol type, out TypeSymbol elementType)
    {
        elementType = null;
        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        foreach (var iface in EnumerateSelfAndInterfaces(clr))
        {
            if (iface.IsGenericType &&
                !iface.IsGenericTypeDefinition &&
                iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IAsyncEnumerable`1")
            {
                elementType = TypeSymbol.FromClrType(iface.GetGenericArguments()[0]);
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Probes <paramref name="clrType"/> for an
    /// <c>IDictionary&lt;TKey, TValue&gt;</c> implementation and returns the
    /// key/value type arguments when present.
    /// </summary>
    /// <param name="clrType">The CLR type to probe.</param>
    /// <param name="keyType">The dictionary's key type, on success.</param>
    /// <param name="valueType">The dictionary's value type, on success.</param>
    /// <returns><see langword="true"/> when the type implements
    /// <c>IDictionary&lt;,&gt;</c>.</returns>
    public static bool TryGetClrDictionaryTypes(Type clrType, out Type keyType, out Type valueType)
    {
        foreach (var iface in EnumerateSelfAndInterfaces(clrType))
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IDictionary`2")
            {
                var args = iface.GetGenericArguments();
                keyType = args[0];
                valueType = args[1];
                return true;
            }
        }

        keyType = null;
        valueType = null;
        return false;
    }

    /// <summary>
    /// Probes <paramref name="clrType"/> for an
    /// <c>IEnumerable&lt;T&gt;</c> implementation (preferred) or a
    /// non-generic <see cref="System.Collections.IEnumerable"/> (fallback
    /// with element type <see cref="object"/>).
    /// </summary>
    /// <param name="clrType">The CLR type to probe.</param>
    /// <param name="elementType">The element CLR type, on success.</param>
    /// <returns><see langword="true"/> when the type is enumerable.</returns>
    public static bool TryGetClrEnumerableElementType(Type clrType, out Type elementType)
    {
        foreach (var iface in EnumerateSelfAndInterfaces(clrType))
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IEnumerable`1")
            {
                elementType = iface.GetGenericArguments()[0];
                return true;
            }
        }

        // Non-generic IEnumerable falls back to object.
        if (typeof(System.Collections.IEnumerable).IsAssignableFrom(clrType))
        {
            elementType = typeof(object);
            return true;
        }

        elementType = null;
        return false;
    }

    /// <summary>
    /// Probes <paramref name="clrType"/> for the C#-style "duck-typed"
    /// enumerable shape: a public instance <c>GetEnumerator()</c> returning
    /// a type that exposes a <c>bool MoveNext()</c> and a <c>Current</c>
    /// property/field.
    /// </summary>
    /// <param name="clrType">The CLR type to probe.</param>
    /// <param name="elementType">The element CLR type, on success.</param>
    /// <returns><see langword="true"/> when the duck-typed shape matches.</returns>
    public static bool TryGetClrPatternEnumerableElementType(Type clrType, out Type elementType)
    {
        var getEnumerator = clrType.GetMethod(
            "GetEnumerator",
            BindingFlags.Instance | BindingFlags.Public,
            binder: null,
            types: Type.EmptyTypes,
            modifiers: null);
        if (getEnumerator == null)
        {
            elementType = null;
            return false;
        }

        var enumeratorType = getEnumerator.ReturnType;
        var moveNext = enumeratorType.GetMethod(
            "MoveNext",
            BindingFlags.Instance | BindingFlags.Public,
            binder: null,
            types: Type.EmptyTypes,
            modifiers: null);
        if (moveNext?.ReturnType != typeof(bool))
        {
            elementType = null;
            return false;
        }

        if (TryGetClrCurrentMemberType(enumeratorType, out elementType))
        {
            return true;
        }

        elementType = null;
        return false;
    }

    /// <summary>
    /// Looks up the <c>Current</c> member on a duck-typed CLR enumerator —
    /// preferring a property over a field, matching the canonical pattern.
    /// </summary>
    /// <param name="enumeratorType">The duck-typed enumerator type.</param>
    /// <param name="elementType">The <c>Current</c> member's CLR type, on success.</param>
    /// <returns><see langword="true"/> when a <c>Current</c> member exists.</returns>
    public static bool TryGetClrCurrentMemberType(Type enumeratorType, out Type elementType)
    {
        var currentProperty = ClrTypeUtilities.SafeGetProperty(enumeratorType, "Current", BindingFlags.Instance | BindingFlags.Public);
        if (currentProperty != null)
        {
            elementType = currentProperty.PropertyType;
            return true;
        }

        var currentField = ClrTypeUtilities.SafeGetField(enumeratorType, "Current", BindingFlags.Instance | BindingFlags.Public);
        if (currentField != null)
        {
            elementType = currentField.FieldType;
            return true;
        }

        elementType = null;
        return false;
    }

    /// <summary>
    /// Probes a user-defined <see cref="StructSymbol"/> for the
    /// duck-typed enumerable shape (<c>GetEnumerator() → MoveNext() / Current</c>).
    /// </summary>
    /// <param name="type">The user struct symbol to probe.</param>
    /// <param name="elementType">The element <see cref="TypeSymbol"/>, on success.</param>
    /// <returns><see langword="true"/> when the duck-typed shape matches.</returns>
    public static bool TryGetUserPatternEnumerableElementType(StructSymbol type, out TypeSymbol elementType)
    {
        if (type.TryGetMethodIncludingInherited("GetEnumerator", out var getEnumerator) &&
            getEnumerator.Parameters.Length == 0 &&
            getEnumerator.Type is StructSymbol enumeratorType &&
            enumeratorType.TryGetMethodIncludingInherited("MoveNext", out var moveNext) &&
            moveNext.Parameters.Length == 0 &&
            moveNext.Type == TypeSymbol.Bool &&
            enumeratorType.TryGetField("Current", out var currentField))
        {
            elementType = currentField.Type;
            return true;
        }

        elementType = null;
        return false;
    }

    /// <summary>
    /// Probes <paramref name="delegateType"/> for the canonical delegate
    /// shape (<see cref="System.MulticastDelegate"/>-derived, or
    /// <c>System.Func`N</c>/<c>System.Action`N</c>) and exposes the
    /// corresponding <see cref="FunctionTypeSymbol"/>.
    /// </summary>
    /// <param name="delegateType">The candidate delegate CLR type.</param>
    /// <param name="functionType">The matching function-type symbol, on success.</param>
    /// <returns><see langword="true"/> when the type is a delegate shape.</returns>
    public static bool TryGetDelegateFunctionType(Type delegateType, out FunctionTypeSymbol functionType)
    {
        functionType = null;
        if (!ClrTypeUtilities.IsDelegateType(delegateType)
            && !string.Equals(delegateType?.BaseType?.FullName, "System.MulticastDelegate", StringComparison.Ordinal)
            && !(delegateType?.FullName?.StartsWith("System.Func`", StringComparison.Ordinal) == true)
            && !(delegateType?.FullName?.StartsWith("System.Action`", StringComparison.Ordinal) == true))
        {
            return false;
        }

        var invoke = delegateType.GetMethod("Invoke");
        if (invoke == null)
        {
            return false;
        }

        var parameters = invoke.GetParameters();
        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(parameters.Length);
        foreach (var parameter in parameters)
        {
            parameterTypes.Add(parameter.ParameterType.ContainsGenericParameters
                ? TypeSymbol.Object
                : TypeSymbol.FromClrType(parameter.ParameterType));
        }

        var returnType = invoke.ReturnType == typeof(void)
            ? TypeSymbol.Void
            : invoke.ReturnType.ContainsGenericParameters
                ? TypeSymbol.Object
                : TypeSymbol.FromClrType(invoke.ReturnType);
        functionType = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), returnType);
        return true;
    }

    /// <summary>
    /// Collects the parameter-name set of every overload of
    /// <paramref name="methodName"/> on <paramref name="receiverClrType"/>.
    /// Used to surface "did you mean X" diagnostics for unknown named
    /// arguments; this helper itself does not emit diagnostics.
    /// </summary>
    /// <param name="receiverClrType">The receiver CLR type.</param>
    /// <param name="methodName">The method simple name.</param>
    /// <param name="bindingFlags">The binding flags to use for the
    /// reflection probe.</param>
    /// <returns>The union of parameter names across matching overloads.
    /// Empty when reflection failed.</returns>
    public static HashSet<string> CollectClrParameterNames(Type receiverClrType, string methodName, BindingFlags bindingFlags)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        MethodInfo[] methods;
        try
        {
            methods = receiverClrType.GetMethods(bindingFlags);
        }
        catch
        {
            return names;
        }

        foreach (var method in methods)
        {
            if (!string.Equals(method.Name, methodName, StringComparison.Ordinal))
            {
                continue;
            }

            foreach (var parameter in method.GetParameters())
            {
                if (parameter.Name != null)
                {
                    names.Add(parameter.Name);
                }
            }
        }

        return names;
    }

    /// <summary>
    /// Collects the parameter-name set across every public instance
    /// constructor of <paramref name="clrType"/>. Used in the same way as
    /// <see cref="CollectClrParameterNames"/>, for constructor call sites.
    /// </summary>
    /// <param name="clrType">The CLR type whose constructors to inspect.</param>
    /// <returns>The union of parameter names across matching constructors.
    /// Empty when reflection failed.</returns>
    public static HashSet<string> CollectClrConstructorParameterNames(Type clrType)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        ConstructorInfo[] ctors;
        try
        {
            ctors = ClrTypeUtilities.SafeGetConstructors(clrType, BindingFlags.Public | BindingFlags.Instance);
        }
        catch
        {
            return names;
        }

        foreach (var ctor in ctors)
        {
            foreach (var parameter in ctor.GetParameters())
            {
                if (parameter.Name != null)
                {
                    names.Add(parameter.Name);
                }
            }
        }

        return names;
    }

    // ----- User-symbol member walks -----

    /// <summary>
    /// Walks <paramref name="structSymbol"/> and its base-class chain looking
    /// for an instance method overload whose CLR-projected signature matches
    /// <paramref name="clrMethod"/>. Used by the interface-implementation
    /// check to decide whether the user struct supplies a given CLR contract
    /// member.
    /// </summary>
    /// <param name="structSymbol">The user struct symbol to inspect.</param>
    /// <param name="clrMethod">The CLR method whose signature to match.</param>
    /// <returns><see langword="true"/> when a matching overload exists.</returns>
    public static bool HasMatchingMethodForClrSignature(StructSymbol structSymbol, MethodInfo clrMethod)
    {
        var clrParams = clrMethod.GetParameters();
        foreach (var candidate in structSymbol.GetMethodsIncludingInherited(clrMethod.Name))
        {
            var callable = GetCallableParameters(candidate);
            if (callable.Length != clrParams.Length)
            {
                continue;
            }

            if (!ClrTypeUtilities.AreSame(candidate.Type?.ClrType, clrMethod.ReturnType))
            {
                continue;
            }

            var allMatch = true;
            for (var i = 0; i < callable.Length; i++)
            {
                if (!ClrTypeUtilities.AreSame(callable[i].Type?.ClrType, clrParams[i].ParameterType))
                {
                    allMatch = false;
                    break;
                }
            }

            if (allMatch)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Looks up a user-declared property on <paramref name="structSymbol"/>
    /// whose name and CLR-projected type match <paramref name="clrProp"/>.
    /// </summary>
    /// <param name="structSymbol">The user struct symbol to inspect.</param>
    /// <param name="clrProp">The CLR property to match.</param>
    /// <returns>The matching <see cref="PropertySymbol"/>, or
    /// <see langword="null"/> when no match exists.</returns>
    public static PropertySymbol FindMatchingProperty(StructSymbol structSymbol, PropertyInfo clrProp)
    {
        foreach (var implProp in structSymbol.Properties)
        {
            if (implProp.Name == clrProp.Name
                && ClrTypeUtilities.AreSame(implProp.Type?.ClrType, clrProp.PropertyType))
            {
                return implProp;
            }
        }

        return null;
    }

    /// <summary>
    /// Walks <paramref name="type"/> and its base-class chain looking for a
    /// user-declared property with the given <paramref name="name"/>.
    /// </summary>
    /// <param name="type">The starting user struct symbol.</param>
    /// <param name="name">The property name to find.</param>
    /// <param name="property">The matching property symbol, on success.</param>
    /// <returns><see langword="true"/> when a property is found.</returns>
    public static bool TryGetPropertyIncludingInherited(StructSymbol type, string name, out PropertySymbol property)
    {
        var current = type;
        while (current != null)
        {
            foreach (var p in current.Properties)
            {
                if (p.Name == name)
                {
                    property = p;
                    return true;
                }
            }

            current = current.BaseClass;
        }

        property = null;
        return false;
    }

    // ----- Indexer / Nullable<> / extension-method probes (instance helpers) -----

    /// <summary>
    /// Looks up a public instance indexer on <paramref name="clrTarget"/>
    /// whose <c>GetIndexParameters()</c> matches <paramref name="boundArguments"/>
    /// by name-based assignability. The caller is expected to have already
    /// bound the index argument expressions — keeping
    /// <see cref="MemberLookup"/> free of <c>BindExpression</c> side effects.
    /// </summary>
    /// <param name="clrTarget">The CLR receiver type whose indexers to probe.</param>
    /// <param name="boundArguments">The pre-bound index argument expressions.</param>
    /// <param name="indexer">The matching <see cref="PropertyInfo"/>, on success.</param>
    /// <returns><see langword="true"/> when a matching indexer is found.</returns>
    public bool TryResolveClrIndexer(Type clrTarget, ImmutableArray<BoundExpression> boundArguments, out PropertyInfo indexer)
    {
        indexer = null;

        foreach (var prop in ClrTypeUtilities.SafeGetProperties(clrTarget, BindingFlags.Public | BindingFlags.Instance))
        {
            var ps = prop.GetIndexParameters();
            if (ps.Length != boundArguments.Length)
            {
                continue;
            }

            var ok = true;
            for (var i = 0; i < ps.Length; i++)
            {
                var argClr = boundArguments[i].Type?.ClrType;
                if (argClr == null || !ClrTypeUtilities.IsAssignableByName(ps[i].ParameterType, argClr))
                {
                    ok = false;
                    break;
                }
            }

            if (ok)
            {
                indexer = prop;
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Constructs <c>Nullable&lt;TUnderlying&gt;</c> projected onto the
    /// binder's <see cref="ReferenceResolver"/>. Returns false when the
    /// open <c>Nullable&lt;&gt;</c> is not reachable from the references in
    /// scope, or when projecting <paramref name="underlying"/> through the
    /// reference set fails.
    /// </summary>
    /// <param name="underlying">The value-type underlying type.</param>
    /// <param name="constructed">The constructed nullable CLR type, on success.</param>
    /// <returns><see langword="true"/> when construction succeeded.</returns>
    public bool TryGetNullableConstructedType(Type underlying, out Type constructed)
    {
        constructed = null;
        if (underlying == null)
        {
            return false;
        }

        if (!this.binderCtx.References.TryResolveType("System.Nullable`1", out var nullableOpen) || nullableOpen == null)
        {
            return false;
        }

        try
        {
            var mappedUnderlying = this.binderCtx.References.MapClrTypeToReferences(underlying) ?? underlying;
            constructed = nullableOpen.MakeGenericType(mappedUnderlying);
            return constructed != null;
        }
        catch
        {
            constructed = null;
            return false;
        }
    }

    /// <summary>
    /// Issue #294: collects every <c>static [Extension]</c> method named
    /// <paramref name="methodName"/> across the imported extension-holding
    /// classes (see <see cref="GetImportedExtensionClasses"/>).
    /// </summary>
    /// <param name="methodName">The extension method's simple name.</param>
    /// <returns>The list of candidate <see cref="MethodInfo"/> overloads.</returns>
    public List<MethodInfo> CollectImportedExtensionMethods(string methodName)
    {
        var result = new List<MethodInfo>();
        foreach (var type in this.GetImportedExtensionClasses())
        {
            MethodInfo[] methods;
            try
            {
                methods = type.GetMethods(BindingFlags.Public | BindingFlags.Static);
            }
            catch
            {
                continue;
            }

            foreach (var method in methods)
            {
                if (!string.Equals(method.Name, methodName, StringComparison.Ordinal))
                {
                    continue;
                }

                if (!HasExtensionAttribute(method))
                {
                    continue;
                }

                if (method.GetParameters().Length == 0)
                {
                    continue;
                }

                result.Add(method);
            }
        }

        return result;
    }

    /// <summary>
    /// Issue #294: enumerates static classes declared in the currently
    /// imported namespaces that carry <c>[Extension]</c> (i.e. host
    /// extension methods). The result is cached on the
    /// <see cref="BinderContext"/> — the import count acts as a cheap
    /// invalidation key because imports only grow during binding.
    /// </summary>
    /// <returns>The imported static extension-holding classes.</returns>
    public List<Type> GetImportedExtensionClasses()
    {
        var imports = this.binderCtx.RootScope.GetDeclaredImports();
        var importCount = imports.IsDefault ? 0 : imports.Length;
        if (this.binderCtx.CachedImportedExtensionClasses != null && this.binderCtx.CachedImportedExtensionImportCount == importCount)
        {
            return this.binderCtx.CachedImportedExtensionClasses;
        }

        var namespaces = new HashSet<string>(StringComparer.Ordinal);
        if (!imports.IsDefault)
        {
            foreach (var import in imports)
            {
                if (!string.IsNullOrEmpty(import.Target))
                {
                    namespaces.Add(import.Target);
                }
            }
        }

        var classes = new List<Type>();
        if (namespaces.Count > 0)
        {
            foreach (var assembly in this.binderCtx.References.Assemblies)
            {
                IEnumerable<Type> types;
                try
                {
                    types = assembly.GetTypes();
                }
                catch (ReflectionTypeLoadException ex)
                {
                    types = ex.Types.Where(t => t != null);
                }
                catch
                {
                    continue;
                }

                foreach (var type in types)
                {
                    if (type == null || type.Namespace == null || !namespaces.Contains(type.Namespace))
                    {
                        continue;
                    }

                    if (!IsStaticClass(type) || !HasExtensionAttribute(type))
                    {
                        continue;
                    }

                    classes.Add(type);
                }
            }
        }

        this.binderCtx.CachedImportedExtensionClasses = classes;
        this.binderCtx.CachedImportedExtensionImportCount = importCount;
        return classes;
    }

    /// <summary>
    /// A C# static class is a sealed abstract class. Detected structurally
    /// so it works under <see cref="System.Reflection.MetadataLoadContext"/>.
    /// </summary>
    /// <param name="type">The candidate type.</param>
    /// <returns><see langword="true"/> when the type is a static class.</returns>
    public static bool IsStaticClass(Type type)
        => type.IsClass && type.IsAbstract && type.IsSealed;

    /// <summary>
    /// Robustly detects <c>[System.Runtime.CompilerServices.ExtensionAttribute]</c>
    /// via <see cref="CustomAttributeData"/> (never runtime
    /// <c>GetCustomAttribute</c>, which throws under
    /// <see cref="System.Reflection.MetadataLoadContext"/>).
    /// </summary>
    /// <param name="member">The type or method to inspect.</param>
    /// <returns><see langword="true"/> when the member carries the
    /// extension attribute.</returns>
    public static bool HasExtensionAttribute(MemberInfo member)
    {
        try
        {
            foreach (var attribute in member.GetCustomAttributesData())
            {
                if (string.Equals(
                    attribute.AttributeType?.FullName,
                    "System.Runtime.CompilerServices.ExtensionAttribute",
                    StringComparison.Ordinal))
                {
                    return true;
                }
            }
        }
        catch
        {
            // Reflection failures (notably in MLC) — treat as "no attribute".
        }

        return false;
    }

    /// <summary>
    /// Returns the callable parameter slice of <paramref name="method"/> —
    /// dropping the synthetic receiver slot used by extension methods so
    /// signature-matching against a CLR contract sees only the
    /// explicitly-declared parameters. Mirrors
    /// <c>Binder.GetCallableParameters</c> byte-for-byte (kept duplicated
    /// rather than widening the binder's helper to <c>internal</c>; the
    /// implementation is a one-liner).
    /// </summary>
    /// <param name="method">The user function symbol.</param>
    /// <returns>The parameters visible to a non-extension caller.</returns>
    private static ImmutableArray<ParameterSymbol> GetCallableParameters(FunctionSymbol method)
        => method.ExplicitReceiverParameter == null ? method.Parameters : method.Parameters.RemoveAt(0);
}
