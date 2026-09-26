// <copyright file="CSharpToGSharpTranslator.NullableFactories.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable annotations

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        private static string?[] CreateNullableFailureArray(int length) => new string?[length];
    }
}
