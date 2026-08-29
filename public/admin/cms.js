/**
 * 博客后台增强：批量上传照片
 *
 * 1. 注册自定义控件 `photo-gallery`：点击一次即可在文件选择框中
 *    同时选中多张照片，全部上传并插入正文，不用再一张一张重复选。
 * 2. 注册 markdown 编辑器组件「📷 批量插入照片」：在正文工具栏的
 *    ➕ 菜单里使用，也可编辑已插入的整组照片。
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || !window.CMS) return;

  function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.slice();
    if (typeof value.toArray === 'function') return value.toArray();
    return [value];
  }

  // ------------------------------------------------------------------
  // 自定义控件 photo-gallery
  // ------------------------------------------------------------------
  var PhotoGalleryControl = window.createClass({
    getInitialState: function () {
      return { uploading: false, uploadingCount: 0, uploadingTotal: 0 };
    },

    componentDidMount: function () {
      this.controlID = 'photo-gallery-' + Math.random().toString(36).slice(2, 12);
    },

    componentWillUnmount: function () {
      if (this.props.onRemoveMediaControl) {
        this.props.onRemoveMediaControl(this.controlID);
      }
    },

    // Widget 层默认只比较 value，媒体库插入只改 mediaPaths 时不会重渲染；
    // 这里参考内置图片控件，把"媒体库返回了新图片"也纳入更新条件
    shouldComponentUpdate: function (nextProps) {
      if (this.props.value !== nextProps.value || this.props.getAsset !== nextProps.getAsset) {
        return true;
      }
      var mediaPath = nextProps.mediaPaths && nextProps.mediaPaths.get(this.controlID);
      if (mediaPath && nextProps.value !== mediaPath) {
        return true;
      }
      return false;
    },

    // 从「媒体库选择」返回后，把选中的图片追加进列表
    componentDidUpdate: function () {
      var mediaPaths = this.props.mediaPaths;
      if (!mediaPaths || !mediaPaths.get) return;
      var inserted = mediaPaths.get(this.controlID);
      if (inserted) {
        this.props.onRemoveInsertedMedia(this.controlID);
        var added = Array.isArray(inserted) ? inserted : [inserted];
        this.addPaths(added);
      }
    },

    valueList: function () {
      return toArray(this.props.value);
    },

    // 把仓库内路径 (static/images/uploads/x.jpg) 转成公开路径 (/images/uploads/x.jpg)
    toPublicPath: function (repoPath) {
      var config = this.props.config || null;
      var mediaFolder = config && config.get ? config.get('media_folder') || '' : '';
      var publicFolder =
        config && config.get ? config.get('public_folder') || '/' + mediaFolder : '';
      var relative = repoPath;
      if (mediaFolder && repoPath.indexOf(mediaFolder) === 0) {
        relative = repoPath.slice(mediaFolder.length).replace(/^\/+/, '');
      } else if (/^static\//.test(repoPath)) {
        relative = repoPath.replace(/^static\//, '');
      }
      return publicFolder.replace(/\/+$/, '') + '/' + relative;
    },

    addPaths: function (paths) {
      var list = this.valueList();
      var changed = false;
      paths.forEach(function (p) {
        if (p && list.indexOf(p) === -1) {
          list.push(p);
          changed = true;
        }
      });
      if (changed) this.props.onChange(list);
    },

    // 核心：一次选中多张照片，逐张上传
    handleFiles: function (event) {
      var files = Array.prototype.slice.call(event.target.files || []);
      event.target.value = null;
      if (!files.length) return;

      var self = this;
      var total = files.length;
      var done = 0;
      var chain = Promise.resolve();

      this.setState({ uploading: true, uploadingCount: 0, uploadingTotal: total });

      files.forEach(function (file) {
        chain = chain
          .then(function () {
            return self.props.onPersistMedia(file, { field: self.props.field });
          })
          .then(function (result) {
            var payload = result && result.payload;
            // 编辑文章时上传走草稿媒体路径 (ADD_DRAFT_ENTRY_MEDIA_FILE)，
            // 路径在 payload.path；普通媒体库上传 (MEDIA_PERSIST_SUCCESS) 在 payload.file.path
            var path = payload && (payload.path || (payload.file && payload.file.path));
            if (path) self.addPaths([self.toPublicPath(path)]);
          })
          .catch(function (err) {
            console.error('照片上传失败: ' + file.name, err);
          })
          .then(function () {
            done += 1;
            self.setState({ uploadingCount: done });
          });
      });

      chain.then(function () {
        self.setState({ uploading: false });
      });
    },

    // 从已有媒体库中选择（默认媒体库为单选）
    openLibrary: function () {
      this.props.onOpenMediaLibrary({
        controlID: this.controlID,
        forImage: true,
        allowMultiple: true,
        config:
          this.props.field && this.props.field.getIn
            ? this.props.field.getIn(['media_library', 'config'])
            : undefined,
        field: this.props.field,
      });
    },

    removeAt: function (index) {
      var list = this.valueList();
      list.splice(index, 1);
      this.props.onChange(list.length ? list : null);
    },

    clearAll: function () {
      this.props.onChange(null);
    },

    render: function () {
      var self = this;
      var value = this.valueList();
      var uploading = this.state.uploading;

      var styles = {
        container: { width: '100%' },
        thumbs: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' },
        thumbWrap: {
          position: 'relative',
          width: '84px',
          height: '84px',
          overflow: 'hidden',
          borderRadius: '4px',
          border: '1px solid rgba(128,128,128,0.4)',
        },
        thumb: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
        removeBtn: {
          position: 'absolute',
          top: '2px',
          right: '2px',
          width: '20px',
          height: '20px',
          lineHeight: '18px',
          textAlign: 'center',
          borderRadius: '50%',
          border: 'none',
          background: 'rgba(0,0,0,0.65)',
          color: '#fff',
          cursor: 'pointer',
          fontSize: '14px',
          padding: 0,
        },
        empty: { color: 'rgba(128,128,128,0.8)', fontSize: '13px', marginBottom: '8px' },
        buttons: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
        btn: {
          display: 'inline-block',
          cursor: 'pointer',
          border: '1px solid rgba(128,128,128,0.5)',
          borderRadius: '4px',
          padding: '6px 12px',
          fontSize: '13px',
          background: 'rgba(128,128,128,0.08)',
          color: 'inherit',
        },
        btnDanger: {
          display: 'inline-block',
          cursor: 'pointer',
          border: '1px solid rgba(255,100,100,0.5)',
          borderRadius: '4px',
          padding: '6px 12px',
          fontSize: '13px',
          background: 'transparent',
          color: '#ff6b6b',
        },
        progress: { fontSize: '12px', color: 'rgba(128,128,128,0.9)' },
      };

      var thumbs = value.map(function (src, i) {
        var asset = self.props.getAsset(src);
        var url = (asset && asset.url) || src;
        return window.h(
          'div',
          { key: src + '-' + i, style: styles.thumbWrap, title: src },
          window.h('img', { src: url, alt: src, style: styles.thumb }),
          window.h(
            'button',
            {
              type: 'button',
              style: styles.removeBtn,
              onClick: function () {
                self.removeAt(i);
              },
              title: '移除这张照片',
            },
            '×'
          )
        );
      });

      var progress = uploading
        ? window.h(
            'span',
            { style: styles.progress },
            '上传中 ' + this.state.uploadingCount + '/' + this.state.uploadingTotal + ' …'
          )
        : null;

      return window.h(
        'div',
        { id: this.props.forID, className: this.props.classNameWrapper, style: styles.container },
        thumbs.length
          ? window.h('div', { style: styles.thumbs }, thumbs)
          : window.h('div', { style: styles.empty }, '还没有选择照片'),
        window.h(
          'div',
          { style: styles.buttons },
          window.h(
            'label',
            { style: styles.btn, title: '打开文件选择框后，可以一次选中多张照片' },
            uploading ? '⏳ 上传中…' : '📷 批量上传照片',
            window.h('input', {
              type: 'file',
              multiple: true,
              accept: 'image/*',
              style: { display: 'none' },
              disabled: uploading,
              onChange: this.handleFiles,
            })
          ),
          window.h(
            'button',
            { type: 'button', style: styles.btn, onClick: this.openLibrary },
            '🖼 从媒体库选择'
          ),
          value.length
            ? window.h(
                'button',
                { type: 'button', style: styles.btnDanger, onClick: this.clearAll },
                '清空'
              )
            : null,
          progress
        )
      );
    },
  });

  var PhotoGalleryPreview = window.createClass({
    render: function () {
      var value = toArray(this.props.value);
      return window.h(
        'div',
        null,
        value.length
          ? value.map(function (src, i) {
              return window.h('img', {
                key: i,
                src: src,
                style: {
                  maxWidth: '100%',
                  display: 'block',
                  margin: '4px 0',
                  borderRadius: '4px',
                },
              });
            })
          : window.h('i', null, '还没有选择照片')
      );
    },
  });

  window.CMS.registerWidget('photo-gallery', PhotoGalleryControl, PhotoGalleryPreview);

  // ------------------------------------------------------------------
  // markdown 编辑器组件：📷 批量插入照片
  // ------------------------------------------------------------------
  window.CMS.registerEditorComponent({
    id: 'photo-batch',
    label: '📷 批量插入照片',
    fields: [
      {
        name: 'photos',
        label: '照片（点击按钮，一次可选中多张上传）',
        widget: 'photo-gallery',
      },
    ],
    pattern: /^(?:\s*!\[[^\]]*\]\([^\n)]+\)\s*)+$/ms,
    fromBlock: function (match) {
      var urls = [];
      var re = /!\[[^\]]*\]\(([^)]+)\)/g;
      var m;
      while ((m = re.exec(match[0]))) {
        urls.push(m[1]);
      }
      return { photos: urls };
    },
    toBlock: function (data) {
      var photos = toArray(data.photos);
      return photos
        .map(function (p) {
          return '![](' + p + ')';
        })
        .join('\n\n');
    },
    toPreview: function (data) {
      var photos = toArray(data.photos);
      return photos
        .map(function (p) {
          return (
            '<img src="' +
            p +
            '" style="max-width:100%;display:block;margin:6px 0;border-radius:4px" />'
          );
        })
        .join('');
    },
  });

  // 手动初始化模式下，完成注册后启动 CMS
  if (window.CMS_MANUAL_INIT && typeof window.initCMS === 'function') {
    window.initCMS();
  }
})();
