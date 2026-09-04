// <copyright file="CSharpToGSharpTranslator.AsyncVoidHandlers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Microsoft.CodeAnalysis;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        private static bool IsCSharpAsyncVoidHandler(IMethodSymbol symbol)
            => symbol is { IsAsync: true, ReturnsVoid: true };
    }
}
