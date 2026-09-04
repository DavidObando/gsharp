// <copyright file="ImportedFunctionSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents an imported function symbol in the language.
/// </summary>
public sealed class ImportedFunctionSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ImportedFunctionSymbol"/> class.
    /// </summary>
    /// <param name="name">The function name.</param>
    /// <param name="importedClass">The imported class that holds this imported function.</param>
    /// <param name="method">The method.</param>
    /// <param name="declaration">The declaration.</param>
    /// <param name="returnTypeOverride">
    /// Issue #320: explicit return type to use instead of the one derived from
    /// <paramref name="method"/>. Supplied when an imported generic method is closed
    /// over a user-defined type argument: the method is closed with a placeholder
    /// CLR type (user types have no reference-context CLR type), so its reflected
    /// return type would be the placeholder rather than the real type argument.
    /// <c>null</c> to derive the return type from the method as usual.
    /// </param>
    public ImportedFunctionSymbol(
        string name,
        ImportedClassSymbol importedClass,
        MethodInfo method,
        ExpressionSyntax? declaration,
        TypeSymbol? returnTypeOverride = null)
        : base(name)
    {
        ImportedClass = importedClass;
        Method = method;
        Declaration = declaration;
        Type = returnTypeOverride ?? GetMethodType(Method);
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.ImportedFunction;

    /// <summary>
    /// Gets the imported class that holds this imported function.
    /// </summary>
    public ImportedClassSymbol ImportedClass { get; }

    /// <summary>
    /// Gets the method.
    /// </summary>
    public MethodInfo Method { get; }

    /// <summary>
    /// Gets the declaration.
    /// </summary>
    public ExpressionSyntax? Declaration { get; }

    /// <summary>
    /// Gets the imported function type.
    /// </summary>
    public TypeSymbol Type { get; }

    /// <summary>
    /// Gets a value indicating whether the method carries
    /// <c>[Gsharp.Concurrency.Suspending]</c> (ADR-0174 D4): it was emitted by
    /// G# as a suspending function, its CLR return type is <c>ValueTask</c> /
    /// <c>ValueTask&lt;R&gt;</c>, and a G# call site awaits it implicitly,
    /// seeing <see cref="LogicalReturnType"/>. Matched by attribute name so the
    /// compiler core takes no reference on the runtime assembly.
    /// </summary>
    public bool IsSuspending => IsSuspendingMethod(Method);

    /// <summary>Gets the logical G# return type: for a suspending method the awaited <c>R</c> (or <c>void</c>), otherwise <see cref="Type"/>.</summary>
    public TypeSymbol LogicalReturnType
        => IsSuspending && AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(Type, out var awaited) ? awaited : Type;

    /// <summary>Reports whether <paramref name="method"/> carries <c>[Gsharp.Concurrency.Suspending]</c>.</summary>
    /// <param name="method">A CLR method.</param>
    /// <returns><see langword="true"/> for a G#-emitted suspending function.</returns>
    public static bool IsSuspendingMethod(MethodInfo method)
    {
        foreach (var attribute in method.GetCustomAttributesData())
        {
            if (attribute.AttributeType.FullName == "Gsharp.Concurrency.SuspendingAttribute")
            {
                return true;
            }
        }

        return false;
    }

    /// <inheritdoc/>
    public override DocumentationComment? GetDocumentation()
    {
        return AssemblyDocumentationProvider.Resolve(Method) ?? base.GetDocumentation();
    }

    private TypeSymbol GetMethodType(MethodInfo method)
    {
        var returnType = ClrNullability.GetReturnTypeSymbol(method);
        return ImportedTypeSymbol.NormalizeSemanticAggregate(returnType, method.ReturnType, ImportedClass.References);
    }
}
