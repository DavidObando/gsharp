// <copyright file="DeinitSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0068 / issue #698: a user-declared destructor (<c>deinit { … }</c>)
/// on a GSharp <c>class</c>. Each <see cref="DeinitSymbol"/> wraps a
/// synthesized <see cref="FunctionSymbol"/> named <c>Finalize</c> whose
/// receiver is the owning class. The emitter materialises that function as
/// a CLR <c>Finalize</c> override whose body is wrapped in
/// <c>try { … } finally { base.Finalize(); }</c>, byte-for-byte identical to
/// what the C# compiler emits for a <c>~Type()</c> destructor.
/// </summary>
/// <remarks>
/// The destructor body is bound and lowered exactly like an instance-method
/// body — the <see cref="Function"/> carries a synthesized <c>this</c>
/// parameter and the body is keyed in <c>BoundProgram.Functions</c> by
/// <see cref="Function"/>. The emitter, however, ignores the standard
/// method-emission path for this function and routes through a dedicated
/// <c>EmitClassDeinitializer</c> that establishes the try/finally region
/// and the chained <c>base.Finalize()</c> call.
/// </remarks>
public sealed class DeinitSymbol
{
    /// <summary>Initializes a new instance of the <see cref="DeinitSymbol"/> class.</summary>
    /// <param name="function">The synthesized <c>Finalize</c> function symbol used as the bind/emit key.</param>
    /// <param name="declaration">The declaring syntax.</param>
    public DeinitSymbol(FunctionSymbol function, DeinitDeclarationSyntax declaration)
    {
        Function = function;
        Declaration = declaration;
    }

    /// <summary>Gets the synthesized <c>Finalize</c> function symbol (receiver = the owning class) keyed in <c>BoundProgram.Functions</c>.</summary>
    public FunctionSymbol Function { get; }

    /// <summary>Gets the declaring syntax node.</summary>
    public DeinitDeclarationSyntax Declaration { get; }

    /// <summary>Gets the owning class.</summary>
    public StructSymbol DeclaringType => Function.ReceiverType as StructSymbol;
}
