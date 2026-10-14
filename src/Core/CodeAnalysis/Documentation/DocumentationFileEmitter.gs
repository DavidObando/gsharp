// <copyright file="DocumentationFileEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Documentation

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import System.Xml

internal shared class DocumentationFileEmitter {
    private data class MemberDocumentation(DocId string, XmlFragment string) : IEquatable[MemberDocumentation] { }

    func Emit(xmlStream Stream, assemblyName string?, program BoundProgram) {
        ArgumentNullException.ThrowIfNull(xmlStream, paramName: "xmlStream")
        ArgumentNullException.ThrowIfNull(program, paramName: "program")
        let members = CollectMembers(program).OrderBy(
            (entry MemberDocumentation) -> entry.DocId,
            StringComparer.Ordinal
        )
            .ToArray()
        using let streamWriter = StreamWriter(xmlStream, UTF8Encoding(false), 1024, leaveOpen: true){NewLine = "\n"}
        streamWriter.WriteLine("<?xml version=\"1.0\"?>")
        let settings = XmlWriterSettings{
            CloseOutput: false,
            Indent: true,
            IndentChars: "    ",
            NewLineChars: "\n",
            OmitXmlDeclaration: true
        }
        using let writer = XmlWriter.Create(streamWriter, settings)
        writer.WriteStartElement("doc")
        writer.WriteStartElement("assembly")
        writer.WriteElementString("name", assemblyName ?? string.Empty)
        writer.WriteEndElement()
        writer.WriteStartElement("members")
        for member in members {
            writer.WriteStartElement("member")
            writer.WriteAttributeString("name", member.DocId)
            if !string.IsNullOrEmpty(member.XmlFragment) {
                writer.WriteRaw("\n")
                writer.WriteRaw(IndentFragment(member.XmlFragment, "            "))
                writer.WriteRaw("\n        ")
            }
            writer.WriteEndElement()
        }
        writer.WriteEndElement()
        writer.WriteEndElement()
        writer.Flush()
        streamWriter.Flush()
    }

    private func CollectMembers(program BoundProgram) IEnumerable[MemberDocumentation] {
        let members = List[MemberDocumentation]()
        for type in program.Structs {
            AddIfDocumented(members, type)
            for field in type.Fields {
                AddIfDocumented(members, field, type)
            }
            for property in type.Properties {
                AddIfDocumented(members, property, type)
            }
            for event in type.Events {
                AddIfDocumented(members, event, type)
            }
            for method in type.Methods {
                AddIfDocumented(members, method)
            }
            for field in type.StaticFields {
                AddIfDocumented(members, field, type)
            }
            for field in type.ConstFields {
                AddIfDocumented(members, field, type)
            }
            for property in type.StaticProperties {
                AddIfDocumented(members, property, type)
            }
            for event in type.StaticEvents {
                AddIfDocumented(members, event, type)
            }
            for method in type.StaticMethods {
                AddIfDocumented(members, method)
            }
            for constructor in type.ExplicitConstructors {
                AddIfDocumented(members, constructor.Function)
            }
        }
        for type in program.Interfaces {
            AddIfDocumented(members, type)
            for method in type.Methods {
                AddIfDocumented(members, method)
            }
            for method in type.StaticMethods {
                AddIfDocumented(members, method)
            }
            for method in type.PrivateMethods {
                AddIfDocumented(members, method)
            }
            for method in type.StaticPrivateMethods {
                AddIfDocumented(members, method)
            }
            for property in type.Properties {
                AddIfDocumented(members, property, type)
            }
            for event in type.Events {
                AddIfDocumented(members, event, type)
            }
            for field in type.StaticFields {
                AddIfDocumented(members, field, type)
            }
            for field in type.ConstFields {
                AddIfDocumented(members, field, type)
            }
        }
        for type in program.Enums {
            AddIfDocumented(members, type)
            for member in type.Members {
                AddIfDocumented(members, member)
            }
        }
        for type in program.Delegates {
            AddIfDocumented(members, type)
        }
        for function in program.Functions.Keys {
            if function.ReceiverType == nil && function.StaticOwnerType == nil {
                AddIfDocumented(members, function)
            }
        }
        return members
    }

    private func AddIfDocumented(members List[MemberDocumentation], symbol Symbol) {
        let documentation DocumentationComment? = symbol.GetDocumentation()
        if documentation == nil {
            return
        }
        let docId string? = SymbolDocumentationIdProvider.GetDocumentationId(symbol)
        if docId == nil {
            return
        }
        members.Add(MemberDocumentation(docId, DocumentationXmlWriter.WriteXmlFragment(documentation)))
    }

    private func AddIfDocumented(members List[MemberDocumentation], symbol Symbol, ownerType TypeSymbol) {
        let documentation DocumentationComment? = symbol.GetDocumentation()
        if documentation == nil {
            return
        }
        let docId string? = SymbolDocumentationIdProvider.GetDocumentationId(symbol, ownerType)
        if docId == nil {
            return
        }
        members.Add(MemberDocumentation(docId, DocumentationXmlWriter.WriteXmlFragment(documentation)))
    }

    private func IndentFragment(fragment string, indentation string) string {
        let normalized = fragment.Replace("\r\n", "\n", StringComparison.Ordinal)
        let lines = normalized.Split('\n')
        let builder = StringBuilder()
        for var i = 0; i < lines.Length; i++ {
            if i > 0 {
                builder.Append('\n')
            }
            if lines[i].Length > 0 {
                builder.Append(indentation)
            }
            builder.Append(lines[i])
        }
        return builder.ToString()
    }
}
