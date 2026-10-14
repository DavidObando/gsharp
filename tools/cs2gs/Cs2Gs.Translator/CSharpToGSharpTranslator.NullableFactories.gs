// <copyright file="CSharpToGSharpTranslator.NullableFactories.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis.CSharp

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        shared {
            private func CreateNullableFailureArray(length int32)[]string? -> [length]string?
        }
    }
}
