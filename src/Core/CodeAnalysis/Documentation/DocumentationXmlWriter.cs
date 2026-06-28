#nullable disable

// <copyright file="DocumentationXmlWriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Text;
using System.Xml;

namespace GSharp.Core.CodeAnalysis.Documentation;

internal static class DocumentationXmlWriter
{
    public static string WriteXmlFragment(DocumentationComment doc)
    {
        if (doc is null)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        var settings = new XmlWriterSettings
        {
            ConformanceLevel = ConformanceLevel.Fragment,
            Indent = true,
            IndentChars = "    ",
            NewLineChars = "\n",
            OmitXmlDeclaration = true,
        };

        using var writer = XmlWriter.Create(builder, settings);
        WriteSection(writer, "summary", doc.Summary);
        WriteParameters(writer, "param", doc.Parameters);
        WriteParameters(writer, "typeparam", doc.TypeParameters);
        WriteSection(writer, "returns", doc.Returns);
        WriteSection(writer, "remarks", doc.Remarks);
        WriteSection(writer, "value", doc.Value);

        foreach (var exception in doc.Exceptions)
        {
            writer.WriteStartElement("exception");
            if (!string.IsNullOrEmpty(exception.Cref))
            {
                writer.WriteAttributeString("cref", exception.Cref);
            }

            WriteInlines(writer, exception.Content);
            writer.WriteEndElement();
        }

        foreach (var reference in doc.SeeAlso)
        {
            writer.WriteStartElement("seealso");
            if (!string.IsNullOrEmpty(reference.Cref))
            {
                writer.WriteAttributeString("cref", reference.Cref);
            }

            if (!string.IsNullOrEmpty(reference.Href))
            {
                writer.WriteAttributeString("href", reference.Href);
            }

            WriteInlines(writer, reference.Content);
            writer.WriteEndElement();
        }

        writer.Flush();
        return builder.ToString();
    }

    private static void WriteParameters(XmlWriter writer, string elementName, ImmutableArray<DocParam> parameters)
    {
        foreach (var parameter in parameters)
        {
            writer.WriteStartElement(elementName);
            writer.WriteAttributeString("name", parameter.Name);
            WriteInlines(writer, parameter.Content);
            writer.WriteEndElement();
        }
    }

    private static void WriteSection(XmlWriter writer, string elementName, ImmutableArray<DocInline> content)
    {
        if (content.IsDefaultOrEmpty)
        {
            return;
        }

        writer.WriteStartElement(elementName);
        WriteInlines(writer, content);
        writer.WriteEndElement();
    }

    private static void WriteInlines(XmlWriter writer, ImmutableArray<DocInline> content)
    {
        foreach (var inline in content)
        {
            WriteInline(writer, inline);
        }
    }

    private static void WriteInline(XmlWriter writer, DocInline inline)
    {
        switch (inline)
        {
            case DocInline.Text text:
                writer.WriteString(text.Value);
                break;
            case DocInline.Code code:
                writer.WriteStartElement("c");
                writer.WriteString(code.Value);
                writer.WriteEndElement();
                break;
            case DocInline.CodeBlock codeBlock:
                writer.WriteStartElement("code");
                if (!string.IsNullOrEmpty(codeBlock.Language))
                {
                    writer.WriteAttributeString("language", codeBlock.Language);
                }

                writer.WriteString(codeBlock.Value);
                writer.WriteEndElement();
                break;
            case DocInline.Para para:
                writer.WriteStartElement("para");
                WriteInlines(writer, para.Content);
                writer.WriteEndElement();
                break;
            case DocInline.List list:
                writer.WriteStartElement("list");
                writer.WriteAttributeString("type", string.IsNullOrEmpty(list.ListType) ? "bullet" : list.ListType);
                foreach (var item in list.Items)
                {
                    writer.WriteStartElement("item");
                    if (!item.Term.IsDefaultOrEmpty)
                    {
                        writer.WriteStartElement("term");
                        WriteInlines(writer, item.Term);
                        writer.WriteEndElement();
                    }

                    writer.WriteStartElement("description");
                    WriteInlines(writer, item.Description);
                    writer.WriteEndElement();
                    writer.WriteEndElement();
                }

                writer.WriteEndElement();
                break;
            case DocInline.SymbolRef symbolRef:
                writer.WriteStartElement("see");
                writer.WriteAttributeString("cref", symbolRef.DocId);
                WriteInlines(writer, symbolRef.Inner);
                writer.WriteEndElement();
                break;
            case DocInline.Link link:
                writer.WriteStartElement("see");
                writer.WriteAttributeString("href", link.Href);
                WriteInlines(writer, link.Inner);
                writer.WriteEndElement();
                break;
            case DocInline.ParamRef paramRef:
                writer.WriteStartElement("paramref");
                writer.WriteAttributeString("name", paramRef.Name);
                writer.WriteEndElement();
                break;
            case DocInline.InheritDoc inheritDoc:
                writer.WriteStartElement("inheritdoc");
                if (!string.IsNullOrEmpty(inheritDoc.Cref))
                {
                    writer.WriteAttributeString("cref", inheritDoc.Cref);
                }

                writer.WriteEndElement();
                break;
            case DocInline.UnknownXmlElement unknownXml:
                writer.WriteRaw(unknownXml.RawXml);
                break;
        }
    }
}
