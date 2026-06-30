package Oahu.Decrypt.Mpeg4

import System.Buffers.Binary
import System.IO
import Oahu.Decrypt.Mpeg4.Boxes

class MetadataItems(AppleListBox AppleListBox) {
    prop FirstAuthor string? -> Artist?.Split(';')?[0]
    prop TitleSansUnabridged string? -> Title?.Replace(" (Unabridged)", "")
    prop BookCopyright string? -> if GetCopyrights() != nil && GetCopyrights()!!!!.Length > 0 { GetCopyrights()!!!![0] } else { default }
    prop RecordingCopyright string? -> if GetCopyrights() != nil && GetCopyrights()!!!!.Length > 1 { GetCopyrights()!!!![1] } else { default }

    prop Title string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameTitle)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameTitle, value)
    }

    prop Producer string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameProducer)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameProducer, value)
    }

    prop Artist string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameArtist)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameArtist, value)
    }

    prop AlbumArtists string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameAlbumArtist)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameAlbumArtist, value)
    }

    prop Album string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameAlbum)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameAlbum, value)
    }

    prop Genres string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameGenres)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameGenres, value)
    }

    prop ProductID string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameProductId)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameProductId, value)
    }

    prop Comment string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameComment)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameComment, value)
    }

    prop LongDescription string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameLongDescription)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameLongDescription, value)
    }

    prop Copyright string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameCopyright)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameCopyright, value)
    }

    prop Publisher string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNamePublisher)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNamePublisher, value)
    }

    prop Year string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameYear)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameYear, value)
    }

    prop Narrator string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameNarrator)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameNarrator, value)
    }

    prop Asin string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameAsin)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameAsin, value)
    }

    prop ReleaseDate string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameReleaseDate)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameReleaseDate, value)
    }

    prop Acr string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameAcr)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameAcr, value)
    }

    prop Version string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameVersion)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameVersion, value)
    }

    prop Encoder string? {
        get -> AppleListBox.GetTagString(MetadataItems.TagNameEncoder)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameEncoder, value)
    }

    prop Cover []?uint8 {
        get -> AppleListBox.GetTagBox(MetadataItems.TagNameCover)?.Data.Data
        set -> SetCoverArt(value)
    }

    prop CoverFormat AppleDataType? -> AppleListBox.GetTagBox(MetadataItems.TagNameCover)?.Data.DataType

    prop TrackNumber TrackNumber? {
        get -> AppleListBox.GetTagData[TrackNumber](MetadataItems.TagNameTrackNumber)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameTrackNumber, value)
    }

    prop DiskNumber DiskNumber? {
        get -> AppleListBox.GetTagData[DiskNumber](MetadataItems.TagNameDiskNumber)
        set -> AppleListBox.EditOrAddTag(MetadataItems.TagNameDiskNumber, value)
    }

    private func GetCopyrights() []?string -> Copyright?.Replace("&#169;", "©")?.Split(';')

    private func SetCoverArt(coverArtBytes []?uint8) {
        let EditOrAdd = func (dataType AppleDataType) {
            if AppleListBox.GetTagBox(MetadataItems.TagNameCover) != nil && AppleListBox.GetTagBox(MetadataItems.TagNameCover)!!!!.Data.DataType != dataType {
                AppleListBox.RemoveTag(AppleListBox.GetTagBox(MetadataItems.TagNameCover)!!!!)
                AppleListBox.GetTagBox(MetadataItems.TagNameCover)!!!!.Dispose()
            }
            AppleListBox.EditOrAddTag(MetadataItems.TagNameCover, coverArtBytes!!, dataType)
        }
        if coverArtBytes == nil {
            AppleListBox.RemoveTag(MetadataItems.TagNameCover)
        } else if coverArtBytes!!.Length >= 2 && BinaryPrimitives.ReadInt16LittleEndian(coverArtBytes!!) == int16(0x4D42) {
            EditOrAdd(AppleDataType.BMP)
        } else if coverArtBytes!!.Length >= 3 && (BinaryPrimitives.ReadInt32LittleEndian(coverArtBytes!!) & 0xFFFFFF) == 0xFFD8FF {
            EditOrAdd(AppleDataType.JPEG)
        } else if coverArtBytes!!.Length >= 8 && BinaryPrimitives.ReadInt64LittleEndian(coverArtBytes!!) == 0xA1A0A0D474e5089L {
            EditOrAdd(AppleDataType.PNG)
        } else {
            throw InvalidDataException("Image data is not a jpeg, PNG, or windows bitmap.")
        }
    }

    shared {
        const TagNameTitle string = "©nam"
        const TagNameProducer string = "©prd"
        const TagNameArtist string = "©ART"
        const TagNameAlbumArtist string = "aART"
        const TagNameAlbum string = "©alb"
        const TagNameGenres string = "©gen"
        const TagNameProductId string = "prID"
        const TagNameComment string = "©cmt"
        const TagNameLongDescription string = "©des"
        const TagNameCopyright string = "cprt"
        const TagNamePublisher string = "©pub"
        const TagNameYear string = "©day"
        const TagNameNarrator string = "©nrt"
        const TagNameAsin string = "CDEK"
        const TagNameReleaseDate string = "rldt"
        const TagNameAcr string = "AACR"
        const TagNameVersion string = "VERS"
        const TagNameEncoder string = "©too"
        const TagNameCover string = "covr"
        const TagNameTrackNumber string = "trkn"
        const TagNameDiskNumber string = "disk"

        func FromFile(mp4File string) MetadataItems? {
            using let file = File.Open(mp4File, FileMode.Open, FileAccess.Read, FileShare.Read)
            var header BoxHeader
            do {
                header = BoxHeader(file!!)
                if header.Type == "moov" {
                    continue
                } else if header.Type == "udta" {
                    break
                } else {
                    file!!.Position += header.TotalBoxSize - int64(header.HeaderSize)
                }
            } while file!!.Position < file!!.Length
            return if header?.Type == "udta" && UdtaBox(file!!, header, nil)?.GetChild[MetaBox]()?.GetChild[AppleListBox]() != nil { MetadataItems(UdtaBox(file!!, header, nil)?.GetChild[MetaBox]()?.GetChild[AppleListBox]()!!!!) } else { default(MetadataItems?) }
        }
    }
}
