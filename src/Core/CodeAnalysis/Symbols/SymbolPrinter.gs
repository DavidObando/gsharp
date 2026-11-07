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
                if symbol is FunctionSymbol function {
                    WriteFunctionTo(function, writer)
                } else {
                    writer.WriteIdentifier(symbol.Name)
                }
            }
            case SymbolKind.GlobalVariable, SymbolKind.LocalVariable {
                if symbol is VariableSymbol variable {
                    WriteVariableTo(variable, writer)
                } else {
                    writer.WriteIdentifier(symbol.Name)
                }
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
            case SymbolKind.ImportedClass {
                WriteImportedClassTo(cast[ImportedClassSymbol](symbol), writer)
            }
            case SymbolKind.ImportedFunction {
                WriteImportedFunctionTo(cast[ImportedFunctionSymbol](symbol), writer)
            }
            case SymbolKind.Field {
                if symbol is FieldSymbol field {
                    WriteFieldTo(field, writer)
                } else {
                    writer.WriteIdentifier(symbol.Name)
                }
            }
            case SymbolKind.Property {
                if symbol is PropertySymbol property {
                    WritePropertyTo(property, writer)
                } else {
                    writer.WriteIdentifier(symbol.Name)
                }
            }
            case SymbolKind.Event {
                if symbol is EventSymbol event_ {
                    WriteEventTo(event_, writer)
                } else {
                    writer.WriteIdentifier(symbol.Name)
                }
            }
            case SymbolKind.TypeAlias {
                if symbol is TypeAliasSymbol typeAlias {
                    WriteTypeAliasTo(typeAlias, writer)
                } else if symbol is ImportSymbol importAlias {
                    WriteImportTo(importAlias, writer)
                } else {
                    writer.WriteIdentifier(symbol.Name)
                }
            }
            default {
                writer.WriteIdentifier(symbol.Name)
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

    private func WriteImportedFunctionTo(symbol ImportedFunctionSymbol, writer TextWriter) {
        writer.WriteKeyword(SyntaxKind.FuncKeyword)
        writer.WriteSpace()
        writer.WriteIdentifier(symbol.Name)
        writer.WritePunctuation(SyntaxKind.OpenParenthesisToken)
        let parameters = ImportedFunctionSymbol.GetLogicalParameters(symbol.Method)
        for var i = 0; i < parameters.Length; i++ {
            if i > 0 {
                writer.WritePunctuation(SyntaxKind.CommaToken)
                writer.WriteSpace()
            }
            writer.WriteIdentifier(parameters[i].Name ?? string.Empty)
            writer.WriteSpace()
            writer.WriteIdentifier(SymbolDisplay.ToTypeDisplayString(parameters[i].ParameterType, qualifyNames: false))
        }
        writer.WritePunctuation(SyntaxKind.CloseParenthesisToken)
        if symbol.Type != nil && symbol.Type != TypeSymbol.Void {
            writer.WriteSpace()
            symbol.Type.WriteTo(writer)
        }
    }

    private func WriteImportedClassTo(symbol ImportedClassSymbol, writer TextWriter) {
        writer.WriteIdentifier(SymbolDisplay.ToTypeDisplayString(symbol.ClassType))
    }

    private func WriteVariableTo(symbol VariableSymbol, writer TextWriter) {
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

    private func WriteFieldTo(symbol FieldSymbol, writer TextWriter) {
        writer.WriteKeyword(
            if symbol.IsConst {
                SyntaxKind.ConstKeyword
            } else if symbol.IsReadOnly {
                SyntaxKind.LetKeyword
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

    private func WritePropertyTo(symbol PropertySymbol, writer TextWriter) {
        writer.WriteIdentifier("prop")
        writer.WriteSpace()
        writer.WriteIdentifier(symbol.Name)
        if symbol.Type != nil {
            writer.WriteSpace()
            symbol.Type.WriteTo(writer)
        }
    }

    private func WriteEventTo(symbol EventSymbol, writer TextWriter) {
        writer.WriteIdentifier("event")
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

    private func WriteTypeAliasTo(symbol TypeAliasSymbol, writer TextWriter) {
        writer.WriteKeyword(SyntaxKind.TypeKeyword)
        writer.WriteSpace()
        writer.WriteIdentifier(symbol.Name)
        writer.WriteSpace()
        writer.WritePunctuation(SyntaxKind.EqualsToken)
        writer.WriteSpace()
        symbol.Target.WriteTo(writer)
    }
}
