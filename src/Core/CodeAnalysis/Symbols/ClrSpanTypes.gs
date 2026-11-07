package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Diagnostics.CodeAnalysis
import System.Reflection

internal shared class ClrSpanTypes {
    internal sealed class Utf8LiteralMembers {
        init(succeeded bool, spanType Type?, createSpan MethodInfo?, slice MethodInfo?) {
            Succeeded = succeeded
            SpanType = spanType
            CreateSpan = createSpan
            Slice = slice
        }

        prop Succeeded bool {
            get;
        }
        prop SpanType Type? {
            get;
        }
        prop CreateSpan MethodInfo? {
            get;
        }
        prop Slice MethodInfo? {
            get;
        }
    }

    internal func TryResolveUtf8Type(references ReferenceResolver, @NotNullWhen(true) out spanType Type?) bool {
        let cached = references.GetOrResolveUtf8LiteralMembers(ResolveUtf8LiteralCore)
        spanType = cached.SpanType
        return spanType != nil
    }

    internal func TryResolveUtf8Literal(
        references ReferenceResolver,
        @NotNullWhen(true) out spanType Type?,
        @NotNullWhen(true) out createSpan MethodInfo?,
        @NotNullWhen(true) out slice MethodInfo?
    ) bool {
        let cached = references.GetOrResolveUtf8LiteralMembers(ResolveUtf8LiteralCore)
        if !cached.Succeeded || cached.SpanType == nil || cached.CreateSpan == nil || cached.Slice == nil {
            spanType = nil
            createSpan = nil
            slice = nil
            return false
        }
        spanType = cached.SpanType
        createSpan = cached.CreateSpan
        slice = cached.Slice
        return true
    }

    private func ResolveUtf8LiteralCore(references ReferenceResolver) Utf8LiteralMembers {
        if !TryResolveDefinition(references, true, out var definition) {
            return Utf8LiteralMembers(false, nil, nil, nil)
        }
        let byteType = references.GetCoreType("System.Byte")
        let intType = references.GetCoreType("System.Int32")
        let resolvedSpan = definition.MakeGenericType([]Type{byteType})
        let slice = resolvedSpan.GetMethod("Slice", []Type{intType, intType})
        if !references.TryResolveType("System.Runtime.CompilerServices.RuntimeHelpers", out var helpers) ||
            helpers == nil ||
            slice == nil ||
            slice.ReturnType != resolvedSpan {
            return Utf8LiteralMembers(false, resolvedSpan, nil, nil)
        }
        for method in helpers.GetMethods(BindingFlags.Public | BindingFlags.Static) {
            if method.Name != "CreateSpan" || !method.IsGenericMethodDefinition || method.GetGenericArguments()
                .Length != 1 {
                continue
            }
            let parameters = method.GetParameters()
            if parameters.Length == 1 && parameters[0].ParameterType == references.GetCoreType(
                "System.RuntimeFieldHandle"
            ) {
                let constructed = method.MakeGenericMethod([]Type{byteType})
                if constructed.ReturnType == resolvedSpan {
                    return Utf8LiteralMembers(true, resolvedSpan, constructed, slice)
                }
            }
        }
        return Utf8LiteralMembers(false, resolvedSpan, nil, nil)
    }

    internal func TryResolveDefinition(
        references ReferenceResolver,
        readOnly bool,
        @NotNullWhen(true) out definition Type?
    ) bool {
        let resolved = references
            .GetCoreType("System.Object")
            .Assembly
            .GetType(
            if readOnly {
                "System.ReadOnlySpan`1"
            } else {
                "System.Span`1"
            },
            throwOnError: false
        )
        definition = resolved
        return resolved != nil &&
            resolved.IsGenericTypeDefinition &&
            resolved.IsValueType &&
            resolved.IsByRefLike &&
            resolved
            .GetGenericArguments().Length == 1
    }
}
