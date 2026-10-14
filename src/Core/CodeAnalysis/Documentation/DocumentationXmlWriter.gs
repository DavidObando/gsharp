// <copyright file="DocumentationXmlWriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Documentation

import System.Collections.Immutable
import System.Text
import System.Xml

internal shared class DocumentationXmlWriter {
    func WriteXmlFragment(doc DocumentationComment?) string {
        if doc == nil {
            return string.Empty
        }
        let builder = StringBuilder()
        let settings = XmlWriterSettings{
            ConformanceLevel: ConformanceLevel.Fragment,
            Indent: true,
            IndentChars: "    ",
            NewLineChars: "\n",
            OmitXmlDeclaration: true
        }
        using let writer = XmlWriter.Create(builder, settings)
        WriteSection(writer, "summary", doc.Summary)
        WriteParameters(writer, "param", doc.Parameters)
        WriteParameters(writer, "typeparam", doc.TypeParameters)
        WriteSection(writer, "returns", doc.Returns)
        WriteSection(writer, "remarks", doc.Remarks)
        WriteSection(writer, "value", doc.Value)
        for exception in doc.Exceptions {
            writer.WriteStartElement("exception")
            if !string.IsNullOrEmpty(exception.Cref) {
                writer.WriteAttributeString("cref", exception.Cref)
            }
            WriteInlines(writer, exception.Content)
            writer.WriteEndElement()
        }
        for reference in doc.SeeAlso {
            writer.WriteStartElement("seealso")
            if !string.IsNullOrEmpty(reference.Cref) {
                writer.WriteAttributeString("cref", reference.Cref)
            }
            if !string.IsNullOrEmpty(reference.Href) {
                writer.WriteAttributeString("href", reference.Href)
            }
            WriteInlines(writer, reference.Content)
            writer.WriteEndElement()
        }
        writer.Flush()
        return builder.ToString()
    }

    private func WriteParameters(writer XmlWriter, elementName string, parameters ImmutableArray[DocParam]) {
        for parameter in parameters {
            writer.WriteStartElement(elementName)
            writer.WriteAttributeString("name", parameter.Name)
            WriteInlines(writer, parameter.Content)
            writer.WriteEndElement()
        }
    }

    private func WriteSection(writer XmlWriter, elementName string, content ImmutableArray[DocInline]) {
        if content.IsDefaultOrEmpty {
            return
        }
        writer.WriteStartElement(elementName)
        WriteInlines(writer, content)
        writer.WriteEndElement()
    }

    private func WriteInlines(writer XmlWriter, content ImmutableArray[DocInline]) {
        for inline in content {
            WriteInline(writer, inline)
        }
    }

    private func WriteInline(writer XmlWriter, inline DocInline) {
        switch inline {
            case text is DocInline.Text {
                writer.WriteString(text.Value)
            }
            case code is DocInline.Code {
                writer.WriteStartElement("c")
                writer.WriteString(code.Value)
                writer.WriteEndElement()
            }
            case codeBlock is DocInline.CodeBlock {
                writer.WriteStartElement("code")
                if !string.IsNullOrEmpty(codeBlock.Language) {
                    writer.WriteAttributeString("language", codeBlock.Language)
                }
                writer.WriteString(codeBlock.Value)
                writer.WriteEndElement()
            }
            case para is DocInline.Para {
                writer.WriteStartElement("para")
                WriteInlines(writer, para.Content)
                writer.WriteEndElement()
            }
            case list is DocInline.List {
                writer.WriteStartElement("list")
                writer.WriteAttributeString(
                    "type",
                    if string.IsNullOrEmpty(list.ListType) {
                        "bullet"
                    } else {
                        list.ListType
                    }
                )
                for item in list.Items {
                    writer.WriteStartElement("item")
                    if !item.Term.IsDefaultOrEmpty {
                        writer.WriteStartElement("term")
                        WriteInlines(writer, item.Term)
                        writer.WriteEndElement()
                    }
                    writer.WriteStartElement("description")
                    WriteInlines(writer, item.Description)
                    writer.WriteEndElement()
                    writer.WriteEndElement()
                }
                writer.WriteEndElement()
            }
            case symbolRef is DocInline.SymbolRef {
                writer.WriteStartElement("see")
                writer.WriteAttributeString("cref", symbolRef.DocId)
                WriteInlines(writer, symbolRef.Inner)
                writer.WriteEndElement()
            }
            case link is DocInline.Link {
                writer.WriteStartElement("see")
                writer.WriteAttributeString("href", link.Href)
                WriteInlines(writer, link.Inner)
                writer.WriteEndElement()
            }
            case paramRef is DocInline.ParamRef {
                writer.WriteStartElement("paramref")
                writer.WriteAttributeString("name", paramRef.Name)
                writer.WriteEndElement()
            }
            case inheritDoc is DocInline.InheritDoc {
                writer.WriteStartElement("inheritdoc")
                if !string.IsNullOrEmpty(inheritDoc.Cref) {
                    writer.WriteAttributeString("cref", inheritDoc.Cref)
                }
                writer.WriteEndElement()
            }
            case unknownXml is DocInline.UnknownXmlElement {
                writer.WriteRaw(unknownXml.RawXml)
            }
        }
    }
}
