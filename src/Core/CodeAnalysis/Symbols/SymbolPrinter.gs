// <copyright file="SymbolPrinter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System.IO
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.IO
import System

/// Symbol printer.
shared class SymbolPrinter {
    /// Writes a symbol to the specified writer.
    /// @param symbol The symbol.
    /// @param writer The writer.
    func WriteTo(symbol Symbol, writer TextWriter) {
        switch symbol.Kind {
            case SymbolKind.Function {
                WriteFunctionTo(cast[FunctionSymbol](symbol), writer)
            }
            case SymbolKind.GlobalVariable {
                WriteGlobalVariableTo(cast[GlobalVariableSymbol](symbol), writer)
            }
            case SymbolKind.LocalVariable {
                WriteLocalVariableTo(cast[LocalVariableSymbol](symbol), writer)
            }
            case SymbolKind.Parameter {
                WriteParameterTo(cast[ParameterSymbol](symbol), writer)
            }
            case SymbolKind.Type {
                WriteTypeTo(cast[TypeSymbol](symbol), writer)
            }
            case SymbolKind.EnumMember {
                WriteEnumMemberTo(cast[EnumMemberSymbol](symbol), writer)
            }
            case SymbolKind.Package {
                WritePackageTo(cast[PackageSymbol](symbol), writer)
            }
            case SymbolKind.Import {
                WriteImportTo(cast[ImportSymbol](symbol), writer)
            }
            default {
                throw Exception("Unexpected symbol: ${symbol.Kind}")
            }
        }
    }

    private func WriteFunctionTo(symbol FunctionSymbol, writer TextWriter) {
        writer.WriteKeyword(SyntaxKind.FuncKeyword)
        writer.WriteSpace()
        writer.WriteIdentifier(symbol.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        for var i = 0; i < symbol.Parameters.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            symbol.Parameters[i].WriteTo(writer)
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
        if symbol.Type != nil {
            writer.WriteSpace()
            symbol.Type.WriteTo(writer)
        }
    }

    private func WriteGlobalVariableTo(symbol GlobalVariableSymbol, writer TextWriter) {
        writer.WriteKeyword(
            if symbol.IsReadOnly {
                SyntaxKind.ConstKeyword
            } else {
                SyntaxKind.VarKeyword
            }
        )
        writer.WriteSpace()
        writer.WriteIdentifier(symbol.Name)
        if symbol.Type != nil {
            writer.WriteSpace()
            symbol.Type.WriteTo(writer)
        }
    }

    private func WriteLocalVariableTo(symbol LocalVariableSymbol, writer TextWriter) {
        writer.WriteKeyword(
            if symbol.IsReadOnly {
                SyntaxKind.ConstKeyword
            } else {
                SyntaxKind.VarKeyword
            }
        )
        writer.WriteSpace()
        writer.WriteIdentifier(symbol.Name)
        if symbol.Type != nil {
            writer.WriteSpace()
            symbol.Type.WriteTo(writer)
        }
    }

    private func WriteParameterTo(symbol ParameterSymbol, writer TextWriter) {
        writer.WriteIdentifier(symbol.Name)
        if symbol.Type != nil {
            writer.WriteSpace()
            symbol.Type.WriteTo(writer)
        }
    }

    private func WriteTypeTo(symbol TypeSymbol, writer TextWriter) {
        writer.WriteIdentifier(SymbolDisplay.ToTypeDisplayString(symbol))
    }

    private func WriteEnumMemberTo(symbol EnumMemberSymbol, writer TextWriter) {
        writer.WriteIdentifier(symbol.EnumType.Name)
        writer.WritePunctuation(SyntaxKind.DotToken)
        writer.WriteIdentifier(symbol.Name)
    }

    private func WritePackageTo(symbol PackageSymbol, writer TextWriter) {
        writer.WriteKeyword(SyntaxKind.PackageKeyword)
        writer.WriteSpace()
        writer.WriteIdentifier(symbol.Name)
    }

    private func WriteImportTo(symbol ImportSymbol, writer TextWriter) {
        writer.WriteKeyword(SyntaxKind.ImportKeyword)
        writer.WriteSpace()
        writer.WriteIdentifier(symbol.Name)
    }
}
