// <copyright file="ImportedFunctionSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Syntax
import System.Reflection

/// Represents an imported function symbol in the language.
class ImportedFunctionSymbol : Symbol {
    /// Initializes a new instance of the (cref:ImportedFunctionSymbol) class.
    /// @param name The function name.
    /// @param importedClass The imported class that holds this imported function.
    /// @param method The method.
    /// @param declaration The declaration.
    /// @param returnTypeOverride Issue #320: explicit return type to use instead of the one derived from
    /// [`method`](paramref). Supplied when an imported generic method is closed
    /// over a user-defined type argument: the method is closed with a placeholder
    /// CLR type (user types have no reference-context CLR type), so its reflected
    /// return type would be the placeholder rather than the real type argument.
    /// `null` to derive the return type from the method as usual.
    init(
        name string,
        importedClass ImportedClassSymbol,
        method MethodInfo,
        declaration ExpressionSyntax?,
        returnTypeOverride TypeSymbol? = nil
    ) : base(name) {
        ImportedClass = importedClass
        Method = method
        Declaration = declaration
        Type = returnTypeOverride ?? GetMethodType(Method)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.ImportedFunction

    /// Gets the imported class that holds this imported function.
    prop ImportedClass ImportedClassSymbol {
        get;
    }

    /// Gets the method.
    prop Method MethodInfo {
        get;
    }

    /// Gets the declaration.
    prop Declaration ExpressionSyntax? {
        get;
    }

    /// Gets the imported function type.
    prop Type TypeSymbol {
        get;
    }

    /// Gets the imported return's managed-reference capability.
    prop ReturnRefKind RefKind -> RefCapabilities.GetReturnRefKind(Method)

    /// Gets a value indicating whether the method carries
    /// `[Gsharp.Concurrency.Suspending]` (ADR-0174 D4): it was emitted by
    /// G# as a suspending function, its CLR return type is `ValueTask` /
    /// `ValueTask<R>`, and a G# call site awaits it implicitly,
    /// seeing (cref:LogicalReturnType). Matched by attribute name so the
    /// compiler core takes no reference on the runtime assembly.
    prop IsSuspending bool -> IsSuspendingMethod(Method)

    /// Gets the logical G# return type: for a suspending method the awaited `R` (or `void`), otherwise
    /// (cref:Type).
    prop LogicalReturnType TypeSymbol -> if IsSuspending && AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(
        Type,
        out var awaited
    ) {
        awaited!!
    } else {
        Type
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetDocumentation() DocumentationComment? {
        return AssemblyDocumentationProvider.Resolve(Method) ?? base.GetDocumentation()
    }

    /// An imported method knows its declaring type from metadata (issue
    /// #3920), so it never depends on having been anchored — nothing anchors
    /// imported symbols, and a migrated analyzer reading
    /// `TargetMethod.ContainingType` saw null for every call into
    /// metadata.
    /// @returns The declaring type, or null for a global method.
    internal override func DefaultContainingType() TypeSymbol? -> if Method.DeclaringType is {} declaringType {
        ImportedTypeSymbol.GetWithoutNullability(declaringType, NullabilityFreeReason.TypeStructure)
    } else {
        default(ImportedTypeSymbol?)
    }

    private func GetMethodType(method MethodInfo) TypeSymbol {
        let returnType = ClrNullability.GetReturnTypeSymbol(method)
        return ImportedTypeSymbol.NormalizeSemanticAggregate(returnType, method.ReturnType, ImportedClass.References)
    }

    shared {
        /// Reports whether [`method`](paramref) carries `[Gsharp.Concurrency.Suspending]`.
        /// @param method A CLR method.
        /// @returns `true` for a G#-emitted suspending function.
        func IsSuspendingMethod(method MethodInfo) bool {
            for attribute in method.GetCustomAttributesData() {
                if attribute.AttributeType.FullName == "Gsharp.Concurrency.SuspendingAttribute" {
                    return true
                }
            }
            return false
        }

        /// Reports whether a suspending method carries ADR-0174's hidden trailing context parameter.
        /// @param method A CLR method.
        /// @returns `true` when the final parameter is the hidden context slot.
        func HasHiddenContextParameter(method MethodInfo) bool {
            let parameters = method.GetParameters()
            return HasHiddenContextParameter(method, parameters)
        }

        /// Gets the source-visible parameters of an imported method, excluding a
        /// validated trailing suspension context slot.
        /// @param method The imported CLR method.
        /// @returns The parameters visible to G# overload and delegate matching.
        func GetLogicalParameters(method MethodInfo)[]ParameterInfo -> GetLogicalParameters(method, out _)

        /// Gets the source-visible parameters of an imported method and reports
        /// whether its full signature carries the hidden suspension context slot.
        /// @param method The imported CLR method.
        /// @param hasHiddenContext Whether the method has a validated hidden context slot.
        /// @returns The parameters visible to G# overload and delegate matching.
        func GetLogicalParameters(method MethodInfo, out hasHiddenContext bool)[]ParameterInfo {
            let parameters = method.GetParameters()
            hasHiddenContext = HasHiddenContextParameter(method, parameters)
            return if hasHiddenContext {
                parameters[.. ^1]
            } else {
                parameters
            }
        }

        private func HasHiddenContextParameter(method MethodInfo, parameters[]ParameterInfo) bool {
            if !IsSuspendingMethod(method) {
                return false
            }
            return parameters.Length > 0 &&
                parameters[^1]
                .ParameterType
                .FullName == "Gsharp.Concurrency.Context" &&
                parameters[^1].Name == FunctionSymbol.HiddenContextParameterName
        }
    }
}
