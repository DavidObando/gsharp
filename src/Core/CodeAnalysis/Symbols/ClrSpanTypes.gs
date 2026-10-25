package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Diagnostics.CodeAnalysis

internal shared class ClrSpanTypes {
    internal func TryResolveDefinition(
        references ReferenceResolver,
        readOnly bool,
        @NotNullWhen(true) out definition Type?
    ) bool {
        definition = references
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
        return definition != nil &&
            definition.IsGenericTypeDefinition &&
            definition.IsValueType &&
            definition.IsByRefLike &&
            definition
            .GetGenericArguments().Length == 1
    }
}
