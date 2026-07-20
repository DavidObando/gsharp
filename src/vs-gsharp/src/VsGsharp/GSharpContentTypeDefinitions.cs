using System.ComponentModel.Composition;
using Microsoft.VisualStudio.LanguageServer.Client;
using Microsoft.VisualStudio.Utilities;

namespace GSharp.VisualStudio;

internal static class GSharpContentTypeDefinitions
{
    public const string ContentTypeName = "gsharp";

    [Export]
    [Name(ContentTypeName)]
    [BaseDefinition(CodeRemoteContentDefinition.CodeRemoteContentTypeName)]
    internal static ContentTypeDefinition GSharpContentType = null!;

    [Export]
    [FileExtension(".gs")]
    [ContentType(ContentTypeName)]
    internal static FileExtensionToContentTypeDefinition GSharpFileExtension = null!;
}
