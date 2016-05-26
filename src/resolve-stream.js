import _ from 'lodash';
import through2 from 'through2';
import duplexer from 'duplexer2';
import regexpTokenizer from 'regexp-stream-tokenizer';

import { parseTransclude, resolveReferences, resolveLink } from './resolve';
import TrimStream from './trim-stream';

import { defaultTokenRegExp, defaultToken, defaultSeparator, WHITESPACE_GROUP } from './config';

/**
* Input stream: object
* - link (string, required)
* - relativePath (string, required)
* - parents (array, required)
* - references (array, required)
*
* Output stream: object
* - chunk (string, required)
*
* Input and output properties can be altered by providing options
*/

export default function ResolveStream(source, opt) {
  const options = _.merge({}, opt);

  function inflate(link, relativePath, references, parents, indent) {
    const resolverStream = new ResolveStream(link);
    const trimmerStream = new TrimStream();

    function token(match) {
      return _.merge(
        defaultToken(match, options, indent),
        {
          relativePath,
          references: [...references],
          parents: [link, ...parents],
        }
      );
    }

    function separator(match) {
      return defaultSeparator(match, indent);
    }

    const tokenizerOptions = { leaveBehind: `${WHITESPACE_GROUP}`, token, separator };
    const linkRegExp = _.get(options, 'linkRegExp') || defaultTokenRegExp;
    const tokenizerStream = regexpTokenizer(tokenizerOptions, linkRegExp);

    trimmerStream.pipe(tokenizerStream).pipe(resolverStream);

    return duplexer({ objectMode: true }, trimmerStream, resolverStream);
  }

  /* eslint-disable consistent-return */
  function transform(chunk, encoding, cb) {
    const transclusionLink = _.get(chunk, 'link');
    const relativePath = _.get(chunk, 'relativePath') || '';
    const parentRefs = _.get(chunk, 'references') || [];
    const parents = _.get(chunk, 'parents') || [];
    const indent = _.get(chunk, 'indent') || '';
    const self = this;

    function handleError(message, path, error) {
      self.push(chunk);
      if (!_.isUndefined(message)) self.emit('error', { message, path, error });
      return cb();
    }

    if (!transclusionLink) return handleError();

    // Parses raw transclusion link: primary.link || fallback.link reference.placeholder:reference.link ...
    parseTransclude(transclusionLink, relativePath, source, (parseErr, primary, fallback, parsedReferences) => {
      if (parseErr) return handleError('Link could not be parsed', transclusionLink, parseErr);

      const references = _.uniq([...parsedReferences, ...parentRefs]);

      // References from parent files override primary links, then to fallback if provided and no matching references
      const link = resolveReferences(primary, fallback, parentRefs);

      // FIXME: link.link is horrible
      this.emit('source', link.link);

      // Resolve link to readable stream
      resolveLink(link, (resolveErr, input, resolvedLink, resolvedRelativePath) => {
        if (resolveErr) return handleError('Link could not be inflated', link, resolveErr);
        if (_.includes(parents, resolvedLink)) return handleError('Circular dependency detected', resolvedLink);

        const inflater = inflate(resolvedLink, resolvedRelativePath, references, parents, indent);

        input.on('error', (inputErr) => {
          this.emit('error', _.merge({ message: 'Could not read file' }, inputErr));
          cb();
        });

        inflater.on('readable', function inputReadable() {
          let content;
          while ((content = this.read()) !== null) {
            self.push(content);
          }
        });

        inflater.on('error', (inflateErr) => {
          this.emit('error', inflateErr);
          cb();
        });

        inflater.on('end', () => cb());

        input.pipe(inflater);
      });
    });
  }

  return through2.obj(transform);
}
